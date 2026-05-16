import { Injectable } from '@nestjs/common';
import type {
  AgentAdapter,
  ChatRequest,
  Message,
  ToolCall,
  TokenUsage,
} from '@agenthub/adapter-core';
import type { ServerEvent } from '@agenthub/shared-types';
import { WorkspaceService } from './workspace.service.js';

export interface AgentToolRunInput {
  adapter: AgentAdapter;
  request: ChatRequest;
  conversationId: string;
  msgId: string;
  send: (event: ServerEvent) => void;
  signal?: AbortSignal;
  maxToolRounds?: number;
}

export interface AgentToolRunResult {
  output: string;
  errored: boolean;
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

    for (let round = 0; round <= maxToolRounds; round++) {
      const toolCalls: ToolCall[] = [];
      let roundText = '';
      let roundErrored = false;

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
                op: 'msg_thinking',
                msgId: input.msgId,
                delta: `\n✏️ 修改 ${event.path}\n`,
              });
              break;
            case 'done':
              finalUsage = event.usage;
              break;
            case 'error':
              roundErrored = true;
              input.send({ op: 'msg_error', msgId: input.msgId, error: event.error });
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
          input.send({ op: 'msg_done', msgId: input.msgId, usage: finalUsage });
          return { output, errored: true };
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
        input.send({ op: 'msg_done', msgId: input.msgId, usage: finalUsage });
        return { output, errored: true };
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (roundErrored) return { output, errored: true };

      if (toolCalls.length === 0) {
        input.send({ op: 'msg_done', msgId: input.msgId, usage: finalUsage });
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
        return { output, errored: true };
      }

      messages.push({
        role: 'assistant',
        content: roundText,
        toolCalls,
      });

      for (const call of toolCalls) {
        const result = await this.executeWorkspaceTool(input.conversationId, call);
        input.send({
          op: 'msg_thinking',
          msgId: input.msgId,
          delta: `\n${describeToolDone(call.name, call.args, result)}\n`,
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
      }
    }

    return { output, errored: false };
  }

  private async executeWorkspaceTool(conversationId: string, call: ToolCall): Promise<unknown> {
    try {
      return {
        ok: true,
        result: await this.workspace.executeTool(conversationId, call.name, call.args),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function appendWorkspaceInstructions(systemPrompt: string | undefined, toolUse: boolean): string | undefined {
  if (!toolUse) return systemPrompt;
  const instructions =
    '## Agentic workspace mode\n\n' +
    'You are not limited to answering with code snippets. When the user asks you to build, modify, debug, or verify a project, use the workspace tools to create/edit/delete files and run terminal commands. ' +
    'Prefer actually writing files and running checks over only explaining what should be done. ' +
    'All file paths are relative to this conversation workspace. Keep command output concise and continue until the task is in a verifiable state.\n\n' +
    'Tool efficiency rules:\n' +
    '- For project generation or multi-file edits, prefer `workspace_write_many` over repeated `workspace_write` calls.\n' +
    '- For inspecting several files, prefer `workspace_read_many` over repeated `workspace_read` calls.\n' +
    '- After writing a coherent batch of files, run one focused verification command instead of repeatedly checking after every small edit.\n' +
    '- If the remaining work is mostly explanation, stop using tools and provide the final status.';
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

function argStr(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** Human "what the agent is about to do" line (Codex-style activity feed). */
function describeToolCall(name: string, args: unknown): string {
  switch (name) {
    case 'workspace_write':
      return `✏️ 写入 ${argStr(args, 'path') ?? '文件'}`;
    case 'workspace_write_many': {
      const files = (args as { files?: unknown[] })?.files;
      const n = Array.isArray(files) ? files.length : 0;
      return `✏️ 批量写入 ${n} 个文件`;
    }
    case 'workspace_read':
      return `📖 读取 ${argStr(args, 'path') ?? '文件'}`;
    case 'workspace_read_many': {
      const files = (args as { files?: unknown[] })?.files;
      const n = Array.isArray(files) ? files.length : 0;
      return `📖 读取 ${n} 个文件`;
    }
    case 'workspace_list':
      return `📂 浏览 ${argStr(args, 'path') ?? '工作区'}`;
    case 'workspace_delete':
      return `🗑️ 删除 ${argStr(args, 'path') ?? ''}`;
    case 'terminal_run':
      return `▶️ 运行 \`${(argStr(args, 'command') ?? '').slice(0, 120)}\``;
    default:
      return `🔧 ${name} ${safeCompactJson(args)}`;
  }
}

/** Human "outcome" line after a tool finished. */
function describeToolDone(name: string, args: unknown, result: unknown): string {
  const r = result as { ok?: boolean; error?: string; result?: unknown } | undefined;
  if (r && r.ok === false) return `✗ 失败：${String(r.error ?? '').slice(0, 200)}`;

  if (name === 'terminal_run') {
    const inner = (r?.result ?? {}) as { exitCode?: number | null; timedOut?: boolean };
    if (inner.timedOut) return `⏱️ 命令超时`;
    return inner.exitCode === 0
      ? `✓ 命令完成（exit 0）`
      : `⚠️ 命令退出码 ${inner.exitCode ?? '?'}`;
  }
  if (name === 'workspace_write' || name === 'workspace_write_many') return `✓ 已写入`;
  if (name === 'workspace_read' || name === 'workspace_read_many' || name === 'workspace_list')
    return `✓ 已读取`;
  if (name === 'workspace_delete') return `✓ 已删除`;
  return `✓ 完成`;
}
