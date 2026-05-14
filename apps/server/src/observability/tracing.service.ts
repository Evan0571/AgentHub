import { Global, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Langfuse, type LangfuseTraceClient } from 'langfuse';

/**
 * Tracing context propagated through async operations via AsyncLocalStorage.
 * When we enter `runWithTrace`, every subsequent adapter.chat() call (within
 * the same async chain) can find the parent trace and attach a child
 * `generation` to it.
 */
export interface TraceContext {
  trace: LangfuseTraceClient;
  /** Free-form metadata mostly for child generations (taskId, agentId, etc). */
  metadata: Record<string, unknown>;
}

/** Public-shape arguments for opening a new top-level trace. */
export interface OpenTraceInput {
  /** Short human-readable name, e.g. 'user_msg', 'orchestrator.plan'. */
  name: string;
  /** Used to filter / group in Langfuse UI. */
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class TracingService implements OnApplicationShutdown {
  private readonly log = new Logger('Tracing');
  private readonly als = new AsyncLocalStorage<TraceContext>();
  private readonly client: Langfuse | null;

  constructor() {
    const pk = process.env.LANGFUSE_PUBLIC_KEY;
    const sk = process.env.LANGFUSE_SECRET_KEY;
    if (!pk || !sk) {
      this.log.warn('LANGFUSE_PUBLIC_KEY/SECRET_KEY not set — observability disabled');
      this.client = null;
      return;
    }
    this.client = new Langfuse({
      publicKey: pk,
      secretKey: sk,
      baseUrl: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
      flushAt: 10,
      flushInterval: 2000,
    });
    this.log.log(`Langfuse enabled @ ${process.env.LANGFUSE_HOST ?? 'cloud.langfuse.com'}`);
  }

  /** True when telemetry is actually being sent (env keys present). */
  isEnabled(): boolean {
    return this.client !== null;
  }

  /** Current trace context, if `runWithTrace` is on the call stack. */
  current(): TraceContext | undefined {
    return this.als.getStore();
  }

  /**
   * Open a new top-level trace and run `fn` inside its async context.
   * Every adapter call within `fn` (and any awaited child) will record a
   * `generation` under this trace. Returns whatever `fn` returns.
   */
  async runWithTrace<T>(input: OpenTraceInput, fn: () => Promise<T>): Promise<T> {
    if (!this.client) return fn();
    const trace = this.client.trace({
      name: input.name,
      userId: input.userId,
      sessionId: input.sessionId,
      metadata: input.metadata ?? {},
    });
    const ctx: TraceContext = { trace, metadata: input.metadata ?? {} };
    try {
      return await this.als.run(ctx, fn);
    } finally {
      // Don't await flush — let it run in background. The shutdown hook flushes
      // for real on graceful exit.
      void this.client.flushAsync().catch(() => undefined);
    }
  }

  /** Force flush — called on app shutdown to ensure no events are dropped. */
  async onApplicationShutdown(): Promise<void> {
    if (this.client) await this.client.shutdownAsync();
  }
}

@Global()
@Module({
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}
