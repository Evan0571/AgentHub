import type {
  AgentAdapter,
  ChatRequest,
  ChatEvent,
  CostEstimate,
  HealthStatus,
  Message,
  TokenUsage,
} from '@agenthub/adapter-core';
import { AdapterError, mapHttpStatus } from '@agenthub/adapter-core';

/**
 * CodexAdapter — talks the OpenAI Chat Completions API with SSE streaming.
 * Despite the name, this adapter is just "OpenAI chat for AgentHub"; the
 * specific model can be swapped via `model` option (gpt-4o-mini default —
 * cheap, fast, strong at code).
 *
 * Uses native fetch instead of the openai SDK to keep the package light
 * and have direct control over the stream loop.
 */

export type CodexModel =
  | 'gpt-4o-mini'
  | 'gpt-4o'
  | 'gpt-4.1'
  | 'gpt-4.1-mini'
  | 'o4-mini'
  | (string & {});

export interface CodexAdapterOptions {
  apiKey: string;
  model?: CodexModel;
  baseURL?: string;
  /** Optional org id for OpenAI accounts that need it. */
  organization?: string;
  id?: string;
  displayName?: string;
}

// USD per 1M tokens; conservative public rates as of late 2025. Update if pricing shifts.
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1': { in: 2.0, out: 8.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'o4-mini': { in: 1.1, out: 4.4 },
};

export class CodexAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities;

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: CodexModel;
  private readonly organization?: string;

  constructor(opts: CodexAdapterOptions) {
    if (!opts.apiKey) throw new Error('CodexAdapter requires apiKey');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-4o-mini';
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.organization = opts.organization;
    this.id = opts.id ?? 'codex';
    this.displayName = opts.displayName ?? `Codex (${this.model})`;

    this.capabilities = {
      streaming: true,
      toolUse: true,
      codeExecution: false, // we don't expose the OpenAI sandbox tool yet
      fileEdit: true, // emulated via prompt + file_patch convention
      webBrowse: false,
      maxContextTokens: 128_000,
      supportedLangs: ['zh', 'en'],
    };
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const t0 = Date.now();
    const body = {
      model: req.model ?? this.model,
      messages: this.translateMessages(req.systemPrompt, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.budget?.maxTokens ? { max_tokens: req.budget.maxTokens } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(this.organization ? { 'OpenAI-Organization': this.organization } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) {
        yield {
          type: 'error',
          error: { code: 'CANCELLED', message: 'aborted', retryable: false },
        };
        return;
      }
      yield new AdapterError({
        code: 'INTERNAL',
        message: `fetch failed: ${(e as Error).message}`,
        retryable: true,
        cause: e,
      }).toEvent();
      return;
    }

    if (!response.ok || !response.body) {
      const text = await safeText(response);
      yield new AdapterError({
        code: mapHttpStatus(response.status),
        message: `OpenAI ${response.status}: ${text}`,
        retryable: response.status >= 500 || response.status === 429,
      }).toEvent();
      return;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: 'stop' | 'length' | 'error' = 'stop';

    try {
      for await (const chunk of parseSSE(response.body, signal)) {
        if (chunk === '[DONE]') break;
        let parsed: any;
        try {
          parsed = JSON.parse(chunk);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: 'token', text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tc.function?.name) continue;
            yield {
              type: 'tool_call',
              call: {
                id: tc.id ?? `oai-${Date.now()}`,
                name: tc.function.name,
                args: safeJSON(tc.function.arguments),
              },
            };
          }
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason === 'length' ? 'length' : 'stop';
        }
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          completionTokens = parsed.usage.completion_tokens ?? completionTokens;
        }
      }
    } catch (e) {
      if (signal?.aborted) {
        yield {
          type: 'error',
          error: { code: 'CANCELLED', message: 'aborted', retryable: false },
        };
        return;
      }
      yield new AdapterError({
        code: 'INTERNAL',
        message: `stream error: ${(e as Error).message}`,
        retryable: true,
        cause: e,
      }).toEvent();
      return;
    }

    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      costUsd: estimateCost(this.model, promptTokens, completionTokens),
      latencyMs: Date.now() - t0,
    };
    yield { type: 'done', finishReason, usage };
  }

  async cancel(_taskId: string): Promise<void> {
    /* AbortSignal handles cancellation */
  }

  estimateCost(req: ChatRequest): CostEstimate {
    const promptTokens = roughTokens(req);
    const p = PRICING[this.model] ?? PRICING['gpt-4o-mini']!;
    return { estimatedCostUsd: (promptTokens / 1_000_000) * p.in, promptTokens };
  }

  async health(): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      const r = await fetch(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return { ok: r.ok, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, notes: (e as Error).message };
    }
  }

  private translateMessages(systemPrompt: string | undefined, msgs: Message[]) {
    const out: Array<{ role: string; content: string; name?: string; tool_call_id?: string }> = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    for (const m of msgs) {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
              .join('\n');
      out.push({
        role: m.role,
        content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      });
    }
    return out;
  }
}

/* ----------------------------------------------------------- helpers ----- */

async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

function safeJSON(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function roughTokens(req: ChatRequest): number {
  const len = req.messages.reduce((acc, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return acc + s.length;
  }, 0);
  return Math.ceil(len / 4);
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model] ?? PRICING['gpt-4o-mini']!;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}
