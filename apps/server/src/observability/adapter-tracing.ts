import type {
  AgentAdapter,
  AdapterMiddleware,
  ChatRequest,
  ChatEvent,
  Message,
} from '@agenthub/adapter-core';
import type { TracingService } from './tracing.service.js';

/**
 * Wrap an AgentAdapter so each chat() call records a Langfuse `generation`
 * under the current trace (if any). When tracing is disabled (no env keys)
 * or no parent trace is active, this is a transparent pass-through.
 */
export function withLangfuse(tracing: TracingService): AdapterMiddleware {
  return (next: AgentAdapter): AgentAdapter => ({
    ...next,
    async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
      const ctx = tracing.current();
      if (!ctx || !tracing.isEnabled()) {
        yield* next.chat(req, signal);
        return;
      }

      const t0 = Date.now();
      // Combine ALS metadata + per-request metadata so the generation tags
      // include conversation/task/agent info for filtering in Langfuse UI.
      const meta = { ...ctx.metadata, ...(req.metadata ?? {}), adapterId: next.id };

      const params: Record<string, number> = {};
      if (req.budget?.maxTokens != null) params.maxTokens = req.budget.maxTokens;
      if (req.budget?.maxTimeMs != null) params.maxTimeMs = req.budget.maxTimeMs;
      const generation = ctx.trace.generation({
        name: `${next.id}:${describePurpose(meta)}`,
        model: req.model ?? next.id,
        modelParameters: Object.keys(params).length ? params : undefined,
        input: serializeInput(req),
        metadata: meta,
      });

      let output = '';
      let thinking = '';
      let usage: { promptTokens: number; completionTokens: number; costUsd?: number; latencyMs: number } | undefined;
      let errored: { code: string; message: string } | undefined;

      try {
        for await (const ev of next.chat(req, signal)) {
          switch (ev.type) {
            case 'token':
              output += ev.text;
              break;
            case 'thinking':
              thinking += ev.text;
              break;
            case 'done':
              usage = ev.usage;
              break;
            case 'error':
              errored = { code: ev.error.code, message: ev.error.message };
              break;
          }
          yield ev;
        }
      } catch (e) {
        errored = { code: 'INTERNAL', message: (e as Error).message };
        throw e;
      } finally {
        generation.end({
          output: thinking ? { content: output, reasoning: thinking } : output,
          usage: usage
            ? {
                input: usage.promptTokens,
                output: usage.completionTokens,
                total: usage.promptTokens + usage.completionTokens,
                unit: 'TOKENS',
                totalCost: usage.costUsd,
              }
            : undefined,
          level: errored ? 'ERROR' : 'DEFAULT',
          statusMessage: errored ? `${errored.code}: ${errored.message}` : undefined,
        });
        void t0;
      }
    },
  });
}

function describePurpose(meta: Record<string, unknown>): string {
  if (typeof meta.purpose === 'string') return meta.purpose;
  if (typeof meta.taskId === 'string') return `task:${meta.taskId}`;
  return 'chat';
}

function serializeInput(req: ChatRequest): unknown {
  // Compact prompts so the Langfuse UI is readable.
  const sys = req.systemPrompt ? truncate(req.systemPrompt, 400) : undefined;
  const msgs = req.messages.map((m: Message) => ({
    role: m.role,
    content: truncate(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      800,
    ),
  }));
  return { system: sys, messages: msgs };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n}ch)` : s;
}
