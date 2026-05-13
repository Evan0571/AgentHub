import type {
  AgentAdapter,
  ChatRequest,
  ChatEvent,
  CostEstimate,
  HealthStatus,
} from '@agenthub/adapter-core';
import { AdapterError, mapHttpStatus } from '@agenthub/adapter-core';

/**
 * ClaudeCodeAdapter — wraps Anthropic Messages API with optional tool use
 * and a file_patch tool that maps to our `file_patch` event.
 *
 * NOTE: this scaffold returns a not-implemented error until wired with
 * the real SDK. Replace the body of chat() with a real streaming call.
 */

export interface ClaudeCodeAdapterOptions {
  apiKey: string;
  model?: string;                  // default "claude-opus-4-7"
  defaultMaxTokens?: number;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly capabilities = {
    streaming: true,
    toolUse: true,
    codeExecution: false,
    fileEdit: true,
    webBrowse: false,
    maxContextTokens: 200_000,
    supportedLangs: ['zh', 'en'],
  };

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {
    if (!opts.apiKey) throw new Error('ClaudeCodeAdapter requires apiKey');
  }

  async *chat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<ChatEvent> {
    // TODO: implement using @anthropic-ai/sdk streaming + tool_use loop.
    // Sketch:
    //   const client = new Anthropic({ apiKey: this.opts.apiKey });
    //   const stream = await client.messages.stream({...});
    //   for await (const ev of stream) yield translate(ev);
    yield new AdapterError({
      code: 'INTERNAL',
      message: 'ClaudeCodeAdapter not implemented yet — wire @anthropic-ai/sdk here',
      retryable: false,
    }).toEvent();
  }

  async cancel(_taskId: string): Promise<void> {
    /* handled via AbortSignal in real impl */
  }

  estimateCost(req: ChatRequest): CostEstimate {
    const promptTokens = roughTokens(req);
    // Indicative pricing only — replace with real card.
    return { estimatedCostUsd: (promptTokens / 1000) * 0.015, promptTokens };
  }

  async health(): Promise<HealthStatus> {
    return { ok: true, notes: 'stub' };
  }
}

function roughTokens(req: ChatRequest): number {
  const len = req.messages.reduce((acc, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return acc + s.length;
  }, 0);
  return Math.ceil(len / 4);
}

// helper to keep the mapHttpStatus import non-unused once you wire the SDK
export const _internal = { mapHttpStatus };
