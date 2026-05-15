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

      for await (const event of input.adapter.chat(request, input.signal)) {
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
              delta: `\n[tool_call] ${event.call.name} ${safeCompactJson(event.call.args)}\n`,
            });
            break;
          case 'tool_result':
            input.send({
              op: 'msg_thinking',
              msgId: input.msgId,
              delta: `\n[tool_result] ${event.callId} ${safeCompactJson(event.result)}\n`,
            });
            break;
          case 'file_patch':
            input.send({
              op: 'msg_thinking',
              msgId: input.msgId,
              delta: `\n[file_patch] ${event.path}\n${event.diff.slice(0, 2000)}\n`,
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
          delta: `\n[tool_done] ${call.name} ${summarizeToolResult(result)}\n`,
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

function safeCompactJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    return String(value);
  }
}

function summarizeToolResult(value: unknown): string {
  const text = safeCompactJson(value);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}
