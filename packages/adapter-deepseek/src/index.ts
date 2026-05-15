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
 * DeepSeekAdapter — talks the OpenAI-compatible Chat Completions API
 * at https://api.deepseek.com. Supported models:
 *   - deepseek-chat     (DeepSeek V3, general purpose)
 *   - deepseek-reasoner (DeepSeek R1, emits reasoning_content)
 *
 * Why we map to native fetch instead of the openai SDK:
 *   - zero extra deps for the package
 *   - first-class control over the SSE stream and `reasoning_content`
 *     which the OpenAI SDK does not type today
 */

export type DeepSeekModel = 'deepseek-chat' | 'deepseek-reasoner' | (string & {});

export interface DeepSeekAdapterOptions {
  apiKey: string;
  model: DeepSeekModel;
  baseURL?: string;
  /** Override the adapter id, useful when registering V3 + R1 side-by-side. */
  id?: string;
  displayName?: string;
}

// USD per 1M tokens; rough public rates as of 2026 — adjust if pricing changes.
const PRICING: Record<string, { in: number; out: number }> = {
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
};

export class DeepSeekAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities;

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: DeepSeekModel;

  constructor(opts: DeepSeekAdapterOptions) {
    if (!opts.apiKey) throw new Error('DeepSeekAdapter requires apiKey');
    if (!opts.model) throw new Error('DeepSeekAdapter requires model');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseURL = (opts.baseURL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    this.id = opts.id ?? (opts.model === 'deepseek-reasoner' ? 'deepseek-r1' : 'deepseek-v3');
    this.displayName =
      opts.displayName ?? (opts.model === 'deepseek-reasoner' ? 'DeepSeek R1' : 'DeepSeek V3');

    const isReasoner = opts.model === 'deepseek-reasoner';
    this.capabilities = {
      streaming: true,
      // R1 currently does NOT support function/tool calls.
      toolUse: !isReasoner,
      codeExecution: false,
      fileEdit: true,        // emulated via prompt + file_patch tool
      webBrowse: false,
      maxContextTokens: 64_000,
      supportedLangs: ['zh', 'en'],
    };
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const t0 = Date.now();
    const body = {
      model: this.model,
      messages: this.translateMessages(req.systemPrompt, req.messages),
      stream: true,
      ...(req.tools?.length && this.capabilities.toolUse
        ? { tools: toOpenAITools(req.tools), tool_choice: 'auto' as const }
        : {}),
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
        message: `DeepSeek ${response.status}: ${text}`,
        retryable: response.status >= 500 || response.status === 429,
      }).toEvent();
      return;
    }

    let usage: TokenUsage | null = null;
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

        if (delta?.reasoning_content) {
          yield { type: 'thinking', text: delta.reasoning_content };
        }
        if (delta?.content) {
          yield { type: 'token', text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === 'number' ? tc.index : toolCallParts.size;
            const existing = toolCallParts.get(index) ?? {
              id: tc.id ?? `dsk-${Date.now()}-${index}`,
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

    usage = {
      promptTokens,
      completionTokens,
      costUsd: estimateCost(this.model, promptTokens, completionTokens),
      latencyMs: Date.now() - t0,
    };
    yield { type: 'done', finishReason, usage };
  }

  async cancel(_taskId: string): Promise<void> {
    /* handled via AbortSignal passed to chat() */
  }

  estimateCost(req: ChatRequest): CostEstimate {
    const promptTokens = roughTokens(req);
    const p = PRICING[this.model] ?? PRICING['deepseek-chat']!;
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
      // DeepSeek follows OpenAI semantics; flatten ContentPart[] to text-only for v1.
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
              .join('\n');
      const row: Record<string, unknown> = {
        role: m.role,
        content: m.toolCalls?.length && m.role === 'assistant' && !content ? null : content,
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
  const p = PRICING[model] ?? PRICING['deepseek-chat']!;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}
