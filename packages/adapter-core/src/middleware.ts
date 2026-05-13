import type { AgentAdapter, ChatEvent, ChatRequest } from './types.js';

/**
 * Adapter middleware — wraps an AgentAdapter to add cross-cutting concerns
 * (logging, caching, rate-limit, prompt rewrite, tracing) without bleeding
 * into business code or vendor SDKs.
 */
export type AdapterMiddleware = (next: AgentAdapter) => AgentAdapter;

export function compose(...mws: AdapterMiddleware[]): AdapterMiddleware {
  return (base) => mws.reduceRight((acc, mw) => mw(acc), base);
}

/** Console-log every chat call with token counts and latency. */
export const withLogging: AdapterMiddleware = (next) => ({
  ...next,
  async *chat(req, signal) {
    const t0 = Date.now();
    console.log(`[adapter:${next.id}] chat start task=${req.taskId} msgs=${req.messages.length}`);
    try {
      for await (const ev of next.chat(req, signal)) {
        if (ev.type === 'done') {
          console.log(
            `[adapter:${next.id}] chat done task=${req.taskId} ` +
              `prompt=${ev.usage.promptTokens} comp=${ev.usage.completionTokens} ` +
              `cost=$${(ev.usage.costUsd ?? 0).toFixed(4)} latency=${Date.now() - t0}ms`,
          );
        }
        yield ev;
      }
    } catch (e) {
      console.error(`[adapter:${next.id}] chat error task=${req.taskId}`, e);
      throw e;
    }
  },
});

/** Naive in-memory result cache keyed by (model + system + messages). Demo only. */
export function withCache(opts: { ttlMs?: number } = {}): AdapterMiddleware {
  const cache = new Map<string, { at: number; events: ChatEvent[] }>();
  const ttl = opts.ttlMs ?? 60_000;

  function key(req: ChatRequest): string {
    return JSON.stringify({ m: req.model, s: req.systemPrompt, msgs: req.messages });
  }

  return (next) => ({
    ...next,
    async *chat(req, signal) {
      const k = key(req);
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < ttl) {
        for (const ev of hit.events) yield ev;
        return;
      }
      const collected: ChatEvent[] = [];
      for await (const ev of next.chat(req, signal)) {
        collected.push(ev);
        yield ev;
      }
      cache.set(k, { at: Date.now(), events: collected });
    },
  });
}

/** Retry transient errors with exponential backoff. */
export function withRetry(opts: { max?: number; baseMs?: number } = {}): AdapterMiddleware {
  const max = opts.max ?? 2;
  const baseMs = opts.baseMs ?? 500;

  return (next) => ({
    ...next,
    async *chat(req, signal) {
      let attempt = 0;
      while (true) {
        try {
          let errored = false;
          for await (const ev of next.chat(req, signal)) {
            if (ev.type === 'error' && ev.error.retryable && attempt < max) {
              errored = true;
              break;
            }
            yield ev;
            if (ev.type === 'done') return;
          }
          if (!errored) return;
          await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
          attempt++;
        } catch (e) {
          if (attempt >= max) throw e;
          await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
          attempt++;
        }
      }
    },
  });
}
