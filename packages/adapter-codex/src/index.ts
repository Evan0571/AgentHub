import type {
  AgentAdapter,
  ChatRequest,
  ChatEvent,
  CostEstimate,
  FinishReason,
  HealthStatus,
  Message,
  ToolCall,
  ToolSchema,
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
      ...(req.tools?.length
        ? { tools: toOpenAITools(req.tools), tool_choice: 'auto' as const }
        : {}),
      ...(req.budget?.maxTokens ? { max_tokens: req.budget.maxTokens } : {}),
    };

    let response: Response;
    // 429 (TPM rate limit) is extremely common when several gpt-4o agents
    // run in parallel on a low-quota key. OpenAI tells us exactly how long
    // to wait ("try again in Xs" / Retry-After header) — honor it and retry
    // in-adapter instead of failing the whole task.
    const maxRateRetries = 5;
    let rateAttempt = 0;
    while (true) {
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

      if (response.ok && response.body) break;

      const text = await safeText(response);
      const isRate = response.status === 429;
      if (isRate && rateAttempt < maxRateRetries && !signal?.aborted) {
        rateAttempt++;
        const waitMs = parseRetryWaitMs(response, text, rateAttempt);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      yield new AdapterError({
        code: mapHttpStatus(response.status),
        message: `OpenAI ${response.status}: ${text}`,
        retryable: response.status >= 500 || response.status === 429,
      }).toEvent();
      return;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: FinishReason = 'stop';
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

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
            const index = typeof tc.index === 'number' ? tc.index : toolCallParts.size;
            const existing = toolCallParts.get(index) ?? {
              id: tc.id ?? `oai-${Date.now()}-${index}`,
              name: '',
              arguments: '',
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            toolCallParts.set(index, existing);
          }
        }
        if (choice?.finish_reason) {
          finishReason =
            choice.finish_reason === 'length'
              ? 'length'
              : choice.finish_reason === 'tool_calls'
                ? 'tool_use'
                : 'stop';
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

    for (const call of finalizeToolCalls(toolCallParts)) {
      yield { type: 'tool_call', call };
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
    const out: Array<Record<string, unknown>> = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    for (const m of msgs) {
      const content = toOpenAIContent(m.content);
      const row: Record<string, unknown> = {
        role: m.role,
        content:
          m.toolCalls?.length &&
          m.role === 'assistant' &&
          ((typeof content === 'string' && !content) || (Array.isArray(content) && content.length === 0))
            ? null
            : content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      };
      if (m.toolCalls?.length) {
        row.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          },
        }));
      }
      out.push(row);
    }
    return out;
  }
}

function toOpenAIContent(content: Message['content']): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${p.mimeType};base64,${p.base64}` },
      };
    }
    return { type: 'text', text: `[tool_result] ${JSON.stringify(p.result)}` };
  });
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

/**
 * How long to wait before retrying a 429. Prefers OpenAI's own guidance:
 *   1. `Retry-After` header (seconds)
 *   2. "Please try again in 4.866s" / "in 500ms" inside the body
 *   3. exponential-ish fallback by attempt number
 * A small jitter + cap avoids thundering-herd when many agents retry together.
 */
function parseRetryWaitMs(res: Response, body: string, attempt: number): number {
  const header = res.headers.get('retry-after');
  let ms = 0;
  if (header && Number.isFinite(Number(header))) {
    ms = Number(header) * 1000;
  } else {
    const m = /try again in\s+([\d.]+)\s*(ms|s)/i.exec(body);
    if (m) {
      const v = Number(m[1]);
      ms = (m[2] ?? 's').toLowerCase() === 'ms' ? v : v * 1000;
    }
  }
  if (!ms || !Number.isFinite(ms)) ms = Math.min(2000 * 2 ** (attempt - 1), 30_000);
  // pad a bit so we don't retry exactly on the boundary, cap at 60s.
  return Math.min(ms + 500 + Math.floor(Math.random() * 400), 60_000);
}

function safeJSON(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toOpenAITools(tools: ToolSchema[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function finalizeToolCalls(
  parts: Map<number, { id: string; name: string; arguments: string }>,
): ToolCall[] {
  return [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, part]) => ({
      id: part.id,
      name: part.name,
      args: safeJSON(part.arguments || '{}'),
    }))
    .filter((call) => call.name);
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
