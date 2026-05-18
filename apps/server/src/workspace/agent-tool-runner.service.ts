import { Injectable } from '@nestjs/common';
import type {
  AgentAdapter,
  AdapterErrorPayload,
  ChatRequest,
  Message,
  ToolCall,
  TokenUsage,
} from '@agenthub/adapter-core';
import type { AgentRuntimeState, ServerEvent } from '@agenthub/shared-types';
import { WorkspaceService } from './workspace.service.js';

export interface AgentToolRunInput {
  adapter: AgentAdapter;
  request: ChatRequest;
  conversationId: string;
  msgId: string;
  send: (event: ServerEvent) => void;
  signal?: AbortSignal;
  maxToolRounds?: number;
  /**
   * When true, this run does NOT emit the terminal `msg_done`. The caller
   * (executor) drives several runs for one message across verification
   * rounds and emits a single final `msg_done` itself — so the message
   * stays in the streaming state and the live activity feed keeps showing
   * instead of collapsing to a "done"-looking thinking block mid-task.
  */
  suppressDone?: boolean;
  suppressRetryableErrors?: boolean;
}

export interface AgentToolRunResult {
  output: string;
  errored: boolean;
  error?: AdapterErrorPayload;
}

@Injectable()
export class AgentToolRunnerService {
  constructor(private readonly workspace: WorkspaceService) {}

  async run(input: AgentToolRunInput): Promise<AgentToolRunResult> {
    const maxToolRounds = input.maxToolRounds ?? defaultMaxToolRounds();
    const messages: Message[] = [...input.request.messages];
    const tools = input.adapter.capabilities.toolUse
      ? [...(input.request.tools ?? []), ...this.workspace.getToolSchemas()]
      : input.request.tools;
    const systemPrompt = appendWorkspaceInstructions(input.request.systemPrompt, input.adapter.capabilities.toolUse);
    let output = '';
    let finalUsage: TokenUsage | undefined;
    sendAgentState(input, 'running', 'model stream started');

    for (let round = 0; round <= maxToolRounds; round++) {
      const toolCalls: ToolCall[] = [];
      let roundText = '';
      let roundErrored = false;
      let roundError: AdapterErrorPayload | undefined;

      const request: ChatRequest = {
        ...input.request,
        systemPrompt,
        messages,
        tools,
        metadata: {
          ...(input.request.metadata ?? {}),
          workspaceId: input.conversationId,
          toolRound: round,
        },
      };

      // Inactivity watchdog: if the adapter produces NO event (no token /
      // thinking / tool / done / error) for `idleMs`, treat the call as hung
      // and abort it so the message surfaces an error instead of an eternal
      // "...". A slow-but-progressing stream keeps resetting the timer.
      const idleMs = idleTimeoutMs();
      const watchdog = new AbortController();
      const signal = mergeSignals(input.signal, watchdog.signal);
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const kick = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          watchdog.abort();
        }, idleMs);
      };

      try {
        kick();
        for await (const event of input.adapter.chat(request, signal)) {
          kick();
          switch (event.type) {
            case 'token':
              output += event.text;
              roundText += event.text;
              input.send({ op: 'msg_token', msgId: input.msgId, delta: event.text });
              break;
            case 'thinking':
              input.send({ op: 'msg_thinking', msgId: input.msgId, delta: event.text });
              break;
            case 'tool_call':
              toolCalls.push(event.call);
              sendAgentActivity(input, event.call, {
                status: 'running',
                title: describeToolCall(event.call.name, event.call.args),
                detail: describeToolArgs(event.call.name, event.call.args),
              });
              input.send({
                op: 'msg_thinking',
                msgId: input.msgId,
                delta: `\n${describeToolCall(event.call.name, event.call.args)}\n`,
              });
              break;
            case 'tool_result':
              // The post-execution `[done]` line below already shows the
              // outcome; skip the noisy raw mid-stream result blob.
              break;
            case 'file_patch':
              input.send({
                op: 'agent_activity',
                activityId: `${input.msgId}:file_patch:${Date.now()}`,
                conversationId: input.conversationId,
                msgId: input.msgId,
                agentId: requestAgentId(input.request),
                agentName: requestAgentName(input.request),
                kind: 'file',
                toolName: 'file_patch',
                status: 'succeeded',
                title: `修改 ${event.path}`,
                detail: event.path,
                createdAt: new Date().toISOString(),
              });
              input.send({
                op: 'msg_thinking',
                msgId: input.msgId,
                delta: `\n修改 ${event.path}\n`,
              });
              break;
            case 'done':
              finalUsage = event.usage;
              break;
            case 'error':
              roundErrored = true;
              roundError = normalizeAdapterError(event.error, input.signal);
              surfaceAdapterError(input, roundError);
              break;
          }
        }
      } catch (e) {
        if (timedOut) {
          input.send({
            op: 'msg_error',
            msgId: input.msgId,
            error: {
              code: 'AGENT_IDLE_TIMEOUT',
              message: `模型 ${Math.round(idleMs / 1000)}s 无任何响应（可能是 model id 不对、网络卡住或 key 失效）。看 server 控制台日志。`,
              retryable: true,
            },
          });
          if (!input.suppressDone) input.send({ op: 'msg_done', msgId: input.msgId, usage: finalUsage });
          sendAgentState(input, 'blocked', `no stream events for ${Math.round(idleMs / 1000)}s`);
          return {
            output,
            errored: true,
            error: {
              code: 'INTERNAL',
              message: `Agent produced no stream events for ${Math.round(idleMs / 1000)}s`,
              retryable: true,
            },
          };
        }
        input.send({
          op: 'msg_error',
          msgId: input.msgId,
          error: {
            code: 'AGENT_STREAM_FAILED',
            message: e instanceof Error ? e.message : String(e),
            retryable: true,
          },
        });
        if (!input.suppressDone) input.send({ op: 'msg_done', msgId: input.msgId, usage: finalUsage });
        sendAgentState(input, 'failed', e instanceof Error ? e.message : String(e));
        return {
          output,
          errored: true,
          error: {
            code: 'INTERNAL',
            message: e instanceof Error ? e.message : String(e),
            retryable: true,
          },
        };
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (roundErrored) {
        sendAgentState(input, 'failed', roundError?.message ?? 'agent stream interrupted');
        return { output, errored: true, error: roundError };
      }

      if (toolCalls.length === 0) {
        if (!input.suppressDone) input.send({ op: 'msg_done', msgId: input.msgId, usage: finalUsage });
        sendAgentState(input, 'idle', 'response complete');
        return { output, errored: false };
      }

      if (round >= maxToolRounds) {
        input.send({
          op: 'msg_error',
          msgId: input.msgId,
          error: {
            code: 'TOOL_ROUND_LIMIT',
            message: `Agent exceeded ${maxToolRounds} workspace tool rounds`,
            retryable: false,
          },
        });
        sendAgentState(input, 'blocked', `tool round limit ${maxToolRounds} reached`);
        return { output, errored: true };
      }

      messages.push({
        role: 'assistant',
        content: roundText,
        toolCalls,
      });

      for (const call of toolCalls) {
        const result = await this.executeWorkspaceTool(input, call);
        const ok = (result as { ok?: boolean } | undefined)?.ok !== false;
        sendAgentActivity(input, call, {
          status: ok ? 'succeeded' : 'failed',
          title: describeToolCall(call.name, call.args),
          detail: describeToolDone(call.name, call.args, result),
        });
        input.send({
          op: 'msg_thinking',
          msgId: input.msgId,
          delta: `\n${describeToolDone(call.name, call.args, result)}\n`,
        });
        // Mirror agent terminal commands into the user's Terminal panel
        // (read-only) so they can watch what the agent runs in real time.
        if (call.name === 'terminal_run') {
          const inner = (result as { ok?: boolean; result?: unknown }).result as
            | {
                command?: string;
                cwd?: string;
                stdout?: string;
                stderr?: string;
                exitCode?: number | null;
                timedOut?: boolean;
              }
            | undefined;
          input.send({
            op: 'agent_terminal',
            conversationId: input.conversationId,
            agentName:
              (input.request.metadata?.agentName as string | undefined) ?? 'agent',
            command:
              inner?.command ??
              ((call.args as { command?: string })?.command ?? ''),
            cwd: inner?.cwd ?? '',
            stdout: inner?.stdout ?? '',
            stderr:
              inner?.stderr ??
              ((result as { ok?: boolean; error?: string }).ok === false
                ? String((result as { error?: string }).error ?? '')
                : ''),
            exitCode: inner?.exitCode ?? null,
            timedOut: inner?.timedOut ?? false,
            createdAt: new Date().toISOString(),
          });
        }
        messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
      }
    }

    return { output, errored: false };
  }

  private async executeWorkspaceTool(input: AgentToolRunInput, call: ToolCall): Promise<unknown> {
    try {
      return {
        ok: true,
        result: await this.workspace.executeTool(input.conversationId, call.name, enrichWorkspaceToolArgs(input, call)),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function normalizeAdapterError(error: AdapterErrorPayload, callerSignal?: AbortSignal): AdapterErrorPayload {
  if (error.code === 'CANCELLED' && !callerSignal?.aborted) {
    return {
      ...error,
      message: error.message || 'stream aborted before completion',
      retryable: true,
    };
  }
  return error;
}

function surfaceAdapterError(input: AgentToolRunInput, error: AdapterErrorPayload): void {
  input.send({
    op: 'agent_activity',
    activityId: `${input.msgId}:stream:${Date.now()}`,
    conversationId: input.conversationId,
    msgId: input.msgId,
    agentId: requestAgentId(input.request),
    agentName: requestAgentName(input.request),
    kind: 'stream',
    status: 'failed',
    title: `Agent stream interrupted: ${error.code}`,
    detail: error.message,
    createdAt: new Date().toISOString(),
  });

  if (input.suppressRetryableErrors && error.retryable) {
    input.send({
      op: 'msg_thinking',
      msgId: input.msgId,
      delta: `\nAgent stream interrupted: ${error.code} - ${error.message}\n`,
    });
    return;
  }

  input.send({ op: 'msg_error', msgId: input.msgId, error });
}

function appendWorkspaceInstructions(systemPrompt: string | undefined, toolUse: boolean): string | undefined {
  if (!toolUse) return systemPrompt;
  const instructions =
    '## Agentic workspace mode\n\n' +
    'You are not limited to answering with code snippets. When the user asks you to build, modify, debug, or verify a project, use the workspace tools to create/edit/delete files and run terminal commands. ' +
    'Prefer actually writing files and running checks over only explaining what should be done. ' +
    'All file paths are relative to this conversation workspace. Keep command output concise and continue until the task is in a verifiable state.\n\n' +
    'Product and implementation rules:\n' +
    '- Ask the user a concrete question when a missing decision would change the product shape, data/compliance boundary, deployment cost, or required credentials. Do not ask for permission to continue when a reasonable low-risk local path exists.\n' +
    '- Do not ship placeholder-only UI or fake capability. Every visible control, chart, table, and KPI must have real local state/data flow/error state, or be explicitly disabled with a concrete next step.\n' +
    '- For external APIs, databases, search, queues, object storage, or auth providers, create `.env.example` with exact variable names and implement a provider boundary. Local mock/demo data must be labeled and isolated behind that boundary.\n' +
    '- If local infrastructure is needed, create or update `docker-compose.yml`, schema/migration/seed files, and run a non-long-running Docker diagnostic such as `docker compose config`. If Docker is unavailable, report the real CLI/daemon error and the exact setup step instead of skipping it.\n' +
    '- Treat PROJECT.md and TEAM_MEMORY.md as shared team memory. Read them before substantial work and update TEAM_MEMORY.md when you change shared decisions, environment contracts, handoffs, or unresolved questions.\n\n' +
    'Team coordination rules:\n' +
    '- Use `task_board_list` before non-trivial work to inspect current owners, dependencies, blockers, handoffs, and artifact paths.\n' +
    '- Use `task_board_update` when you start, block, finish, or hand off a task. Include concrete blockers, failed commands, credential names, or produced workspace paths so the next agent can continue without guessing.\n\n' +
    '- Use `team_message_list` before starting implementation work; use `team_message_send` for directed teammate handoffs or API/data/env contract changes that a specific role must see.\n' +
    '- Use `team_wake_list` to see directed messages that should wake or be claimed by your role; use `team_wake_update` after claiming or resolving one.\n' +
    '- Use `memory_context` with a task-specific `query` before substantial work. Treat returned highlights as the first-pass memory index, then read full entries only when needed. Use `memory_note` only for durable facts: product decisions, shared contracts, role learnings, or local setup caveats.\n' +
    '- Before your final response, run a memory review in your own reasoning: if this work changed product decisions, shared APIs/schemas, env variables, Docker/database services, deployment commands, role handoffs, or local setup caveats, call `memory_note` first. If nothing durable changed, do not write memory.\n\n' +
    'Tool efficiency rules:\n' +
    '- For project generation or multi-file edits, prefer `workspace_write_many` over repeated `workspace_write` calls.\n' +
    '- For inspecting several files, prefer `workspace_read_many` over repeated `workspace_read` calls.\n' +
    '- After writing a coherent batch of files, run one focused verification command instead of repeatedly checking after every small edit.\n' +
    '- If the remaining work is mostly explanation, stop using tools and provide the final status.\n\n' +
    'Output style rules:\n' +
    '- Do not use emoji.\n' +
    '- Do not narrate every tool step in the final answer; the UI already shows tool activity separately.\n' +
    '- Avoid canned phrases like "I will", "first", "next", "summary", and "let me know". Report concrete results, files changed, verification, and blockers.';
  return [systemPrompt, instructions].filter(Boolean).join('\n\n');
}

function defaultMaxToolRounds(): number {
  const raw = Number(process.env.AGENTHUB_MAX_TOOL_ROUNDS ?? 24);
  if (!Number.isFinite(raw)) return 24;
  return Math.max(4, Math.min(80, Math.trunc(raw)));
}

/** Max seconds of total silence from the adapter before we abort the call. */
function idleTimeoutMs(): number {
  const raw = Number(process.env.AGENTHUB_AGENT_IDLE_TIMEOUT_MS ?? 90_000);
  if (!Number.isFinite(raw)) return 90_000;
  return Math.max(15_000, Math.min(600_000, Math.trunc(raw)));
}

/** Combine an optional caller signal with the watchdog signal. */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const merged = new AbortController();
  const onAbort = () => merged.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return merged.signal;
}

function safeCompactJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    return String(value);
  }
}

function requestAgentName(req: ChatRequest): string {
  const raw = req.metadata?.agentName;
  return typeof raw === 'string' && raw.trim() ? raw : 'Agent';
}

function requestAgentId(req: ChatRequest): string | undefined {
  const raw = req.metadata?.agentId;
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

function enrichWorkspaceToolArgs(input: AgentToolRunInput, call: ToolCall): unknown {
  if (!call.args || typeof call.args !== 'object') return call.args;
  const args = { ...(call.args as Record<string, unknown>) };
  const agentId = requestAgentId(input.request);
  const agentName = requestAgentName(input.request);

  if (call.name === 'team_message_send') {
    if (!args.fromAgentId && agentId) args.fromAgentId = agentId;
    if (!args.fromAgentName) args.fromAgentName = agentName;
  }

  if (call.name === 'team_message_list') {
    if (!args.recipient) args.recipient = agentName || agentId;
  }

  if (call.name === 'team_wake_list') {
    if (!args.target) args.target = agentName || agentId;
  }

  if (call.name === 'team_wake_update') {
    if (!args.agentId && agentId) args.agentId = agentId;
    if (!args.agentName) args.agentName = agentName;
  }

  if (call.name === 'memory_context' || call.name === 'memory_note') {
    if (!args.agentId && agentId) args.agentId = agentId;
    if (!args.agentName) args.agentName = agentName;
  }

  return args;
}

function sendAgentActivity(
  input: AgentToolRunInput,
  call: ToolCall,
  event: {
    status: 'running' | 'succeeded' | 'failed';
    title: string;
    detail?: string;
  },
): void {
  input.send({
    op: 'agent_activity',
    activityId: `${input.msgId}:tool:${call.id}`,
    conversationId: input.conversationId,
    msgId: input.msgId,
    agentId: requestAgentId(input.request),
    agentName: requestAgentName(input.request),
    kind: activityKindForTool(call.name),
    toolName: call.name,
    status: event.status,
    title: event.title,
    detail: event.detail,
    createdAt: new Date().toISOString(),
  });
}

function sendAgentState(
  input: AgentToolRunInput,
  state: AgentRuntimeState,
  reason?: string,
): void {
  input.send({
    op: 'agent_state',
    conversationId: input.conversationId,
    agentId: requestAgentId(input.request),
    agentName: requestAgentName(input.request),
    msgId: input.msgId,
    state,
    reason,
    updatedAt: new Date().toISOString(),
  });
}

function activityKindForTool(name: string): 'workspace' | 'terminal' | 'file' | 'stream' {
  if (name === 'terminal_run') return 'terminal';
  if (name === 'file_patch') return 'file';
  return 'workspace';
}

function argStr(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** Human "what the agent is about to do" line (Codex-style activity feed). */
function describeToolCall(name: string, args: unknown): string {
  switch (name) {
    case 'workspace_write':
      return `写入 ${argStr(args, 'path') ?? '文件'}`;
    case 'workspace_write_many': {
      const files = (args as { files?: unknown[] })?.files;
      const n = Array.isArray(files) ? files.length : 0;
      return `批量写入 ${n} 个文件`;
    }
    case 'workspace_read':
      return `读取 ${argStr(args, 'path') ?? '文件'}`;
    case 'workspace_read_many': {
      const files = (args as { files?: unknown[] })?.files;
      const n = Array.isArray(files) ? files.length : 0;
      return `读取 ${n} 个文件`;
    }
    case 'workspace_list':
      return `浏览 ${argStr(args, 'path') ?? '工作区'}`;
    case 'workspace_delete':
      return `删除 ${argStr(args, 'path') ?? ''}`;
    case 'task_board_list':
      return 'Read team task board';
    case 'task_board_update':
      return `Update task board ${argStr(args, 'taskId') ?? ''}`;
    case 'team_message_send':
      return `Send teammate message to ${argStr(args, 'to') ?? 'teammate'}`;
    case 'team_message_list':
      return 'Read teammate mailbox';
    case 'team_message_mark_read':
      return 'Mark teammate messages read';
    case 'team_wake_list':
      return 'Read teammate wake queue';
    case 'team_wake_update':
      return `Update wake request ${argStr(args, 'wakeId') ?? ''}`;
    case 'memory_context':
      return 'Read layered memory';
    case 'memory_note':
      return 'Write memory note';
    case 'terminal_run':
      return `运行 \`${(argStr(args, 'command') ?? '').slice(0, 120)}\``;
    default:
      return `${name} ${safeCompactJson(args)}`;
  }
}

function describeToolArgs(name: string, args: unknown): string {
  switch (name) {
    case 'workspace_write':
    case 'workspace_read':
    case 'workspace_delete':
      return argStr(args, 'path') ?? '';
    case 'workspace_write_many':
    case 'workspace_read_many': {
      const files = (args as { files?: Array<{ path?: unknown }> })?.files;
      if (!Array.isArray(files)) return '';
      return files
        .slice(0, 8)
        .map((file) => (typeof file.path === 'string' ? file.path : null))
        .filter(Boolean)
        .join('\n');
    }
    case 'workspace_list':
      return argStr(args, 'path') || 'workspace root';
    case 'task_board_update':
      return [argStr(args, 'taskId'), argStr(args, 'status'), argStr(args, 'blocker'), argStr(args, 'handoff')]
        .filter(Boolean)
        .join('\n');
    case 'task_board_list':
      return '.agenthub/TASK_BOARD.json';
    case 'team_message_send':
      return [argStr(args, 'to'), argStr(args, 'subject')].filter(Boolean).join('\n');
    case 'team_message_list':
      return argStr(args, 'recipient') || 'current agent';
    case 'team_message_mark_read':
      return safeCompactJson(args);
    case 'team_wake_list':
      return argStr(args, 'target') || 'current agent';
    case 'team_wake_update':
      return [argStr(args, 'wakeId'), argStr(args, 'status')].filter(Boolean).join('\n');
    case 'memory_context':
      return argStr(args, 'query') || 'PROJECT.md\nTEAM_MEMORY.md\n.agenthub/memory';
    case 'memory_note':
      return [argStr(args, 'scope'), argStr(args, 'title'), argStr(args, 'note')].filter(Boolean).join('\n');
    case 'terminal_run':
      return argStr(args, 'command') ?? '';
    default:
      return safeCompactJson(args);
  }
}

/** Human "outcome" line after a tool finished. */
function describeToolDone(name: string, args: unknown, result: unknown): string {
  const r = result as { ok?: boolean; error?: string; result?: unknown } | undefined;
  if (r && r.ok === false) return `✗ 失败：${String(r.error ?? '').slice(0, 200)}`;

  if (
    name === 'team_message_send' ||
    name === 'team_message_list' ||
    name === 'team_message_mark_read' ||
    name === 'team_wake_list' ||
    name === 'team_wake_update' ||
    name === 'memory_context' ||
    name === 'memory_note'
  ) {
    return 'Done';
  }

  if (name === 'terminal_run') {
    const inner = (r?.result ?? {}) as { exitCode?: number | null; timedOut?: boolean };
    if (inner.timedOut) return `命令超时`;
    return inner.exitCode === 0
      ? `命令完成（exit 0）`
      : `命令退出码 ${inner.exitCode ?? '?'}`;
  }
  if (name === 'workspace_write' || name === 'workspace_write_many') return `已写入`;
  if (name === 'workspace_read' || name === 'workspace_read_many' || name === 'workspace_list')
    return `已读取`;
  if (name === 'workspace_delete') return `已删除`;
  return `完成`;
}
