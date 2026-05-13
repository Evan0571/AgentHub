import type {
  AgentAdapter,
  ChatRequest,
  ChatEvent,
  CostEstimate,
  HealthStatus,
} from '@agenthub/adapter-core';
import { AdapterError } from '@agenthub/adapter-core';

/** CodexAdapter — OpenAI Responses API + agentic file_edit loop. */

export interface CodexAdapterOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;                  // e.g. "gpt-4.1" / "o4-mini-high" / "codex-mini"
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly capabilities = {
    streaming: true,
    toolUse: true,
    codeExecution: true,           // codex can run code in OpenAI sandbox
    fileEdit: true,
    webBrowse: true,
    maxContextTokens: 128_000,
    supportedLangs: ['zh', 'en'],
  };

  constructor(private readonly opts: CodexAdapterOptions) {
    if (!opts.apiKey) throw new Error('CodexAdapter requires apiKey');
  }

  async *chat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<ChatEvent> {
    // TODO: implement with `openai` SDK Responses API streaming.
    yield new AdapterError({
      code: 'INTERNAL',
      message: 'CodexAdapter not implemented yet — wire openai SDK here',
      retryable: false,
    }).toEvent();
  }

  async cancel(_taskId: string): Promise<void> {
    /* AbortSignal handles it */
  }

  estimateCost(req: ChatRequest): CostEstimate {
    const promptTokens = roughTokens(req);
    return { estimatedCostUsd: (promptTokens / 1000) * 0.005, promptTokens };
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
