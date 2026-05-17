import type {
  AgentAdapter,
  AdapterMiddleware,
  ChatRequest,
  ChatEvent,
} from '@agenthub/adapter-core';
import type { TracingService } from './tracing.service.js';
import type { UsageRepo } from '../db/usage.repo.js';

/**
 * Records one `agent_calls` row per adapter chat (tokens / cost / latency /
 * status), so the group can show real-time spend broken down by model.
 *
 * Conversation id is taken from the ALS trace metadata (sessionId =
 * conversationId) first, then per-request metadata. It is independent of
 * Langfuse being enabled — usage accounting always runs.
 */
export function withUsage(usage: UsageRepo, tracing: TracingService): AdapterMiddleware {
  return (next: AgentAdapter): AgentAdapter => ({
    ...next,
    async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
      const ctx = tracing.current();
      const meta = { ...(ctx?.metadata ?? {}), ...(req.metadata ?? {}) } as Record<string, unknown>;
      const conversationId =
        pickString(meta.conversationId) ?? pickString(meta.sessionId) ?? null;
      const model = pickString(req.model) ?? pickString(meta.model) ?? null;

      const t0 = Date.now();
      let prompt = 0;
      let completion = 0;
      let cost = 0;
      let status = 'ok';
      let errorCode: string | null = null;

      try {
        for await (const ev of next.chat(req, signal)) {
          if (ev.type === 'done') {
            prompt = ev.usage.promptTokens ?? 0;
            completion = ev.usage.completionTokens ?? 0;
            cost = ev.usage.costUsd ?? 0;
          } else if (ev.type === 'error') {
            status = 'error';
            errorCode = ev.error.code;
          }
          yield ev;
        }
      } catch (e) {
        status = 'error';
        errorCode = 'INTERNAL';
        void usage.record({
          conversationId,
          adapterId: next.id,
          model,
          promptTokens: prompt,
          completionTokens: completion,
          costUsd: cost,
          latencyMs: Date.now() - t0,
          status,
          errorCode: (e as Error).message?.slice(0, 60) ?? errorCode,
        });
        throw e;
      }

      void usage.record({
        conversationId,
        adapterId: next.id,
        model,
        promptTokens: prompt,
        completionTokens: completion,
        costUsd: cost,
        latencyMs: Date.now() - t0,
        status,
        errorCode,
      });
    },
  });
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
