import type {
  AgentAdapter,
  ChatRequest,
  ChatEvent,
  CostEstimate,
  HealthStatus,
} from '@agenthub/adapter-core';
import { AdapterError } from '@agenthub/adapter-core';

/** DoubaoAdapter — 火山方舟（Volcengine Ark）OpenAI-compatible endpoint. */

export interface DoubaoAdapterOptions {
  apiKey: string;
  endpoint?: string;               // default https://ark.cn-beijing.volces.com/api/v3
  model?: string;                  // e.g. "doubao-pro-32k"
}

export class DoubaoAdapter implements AgentAdapter {
  readonly id = 'doubao';
  readonly displayName = '豆包 / Doubao';
  readonly capabilities = {
    streaming: true,
    toolUse: true,
    codeExecution: false,
    fileEdit: true,
    webBrowse: false,
    maxContextTokens: 32_000,
    supportedLangs: ['zh', 'en'],
  };

  constructor(private readonly opts: DoubaoAdapterOptions) {
    if (!opts.apiKey) throw new Error('DoubaoAdapter requires apiKey');
  }

  async *chat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<ChatEvent> {
    // TODO: implement with fetch() against Ark OpenAI-compatible /chat/completions
    yield new AdapterError({
      code: 'INTERNAL',
      message: 'DoubaoAdapter not implemented yet — wire Ark fetch here',
      retryable: false,
    }).toEvent();
  }

  async cancel(_taskId: string): Promise<void> {
    /* AbortSignal handles it */
  }

  estimateCost(req: ChatRequest): CostEstimate {
    const promptTokens = roughTokens(req);
    return { estimatedCostUsd: (promptTokens / 1000) * 0.001, promptTokens };
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
