import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdapterRegistry,
  compose,
  withLogging,
  withRetry,
  type AgentAdapter,
} from '@agenthub/adapter-core';
import { MockAdapter } from '@agenthub/adapter-mock';
import { DeepSeekAdapter } from '@agenthub/adapter-deepseek';
import { CodexAdapter } from '@agenthub/adapter-codex';
import { ClaudeCodeAdapter } from '@agenthub/adapter-claude-code';
import { DoubaoAdapter } from '@agenthub/adapter-doubao';
import { createHash } from 'node:crypto';
import { ADAPTER_REGISTRY } from './constants.js';
import { TracingService } from '../observability/tracing.service.js';
import { withLangfuse } from '../observability/adapter-tracing.js';

/**
 * Resolves an `AgentAdapter` instance for a given agent row, honoring its
 * per-agent overrides (model, baseUrl, BYOK apiKey). Falls back to the
 * env-configured pre-registered adapter when no overrides are set.
 *
 * Built adapters are cached by `(adapterId, model, baseUrl, apiKey-hash)`
 * so repeated calls reuse the same instance (and middleware chain).
 */
export interface ResolvedAgentSpec {
  /** Used for cache key + as the wrapped adapter's id for tracing. */
  agentId: string;
  /** Provider type. */
  adapterId: string;
  /** Model id at the provider (e.g. `gpt-4o`, `deepseek-chat`). */
  model: string | null;
  /** Plaintext API key (already decrypted) or null to use env default. */
  apiKey: string | null;
  /** Custom OpenAI-compatible base URL, or null. */
  baseUrl: string | null;
}

@Injectable()
export class AdapterFactoryService {
  private readonly log = new Logger('AdapterFactory');
  private readonly cache = new Map<string, AgentAdapter>();

  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly tracing: TracingService,
  ) {}

  resolveForAgent(spec: ResolvedAgentSpec): AgentAdapter {
    const hasOverride = !!(spec.apiKey || spec.baseUrl || spec.model);

    // Fast path: no overrides → use the env-keyed adapter registered at boot.
    if (!hasOverride && this.registry.has(spec.adapterId)) {
      return this.registry.get(spec.adapterId);
    }

    const cacheKey = this.cacheKey(spec);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const built = this.build(spec);
    this.cache.set(cacheKey, built);
    return built;
  }

  /** Invalidate any cached adapter for the given agent (called on update / delete). */
  invalidate(agentId: string): void {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(`${agentId}::`)) this.cache.delete(k);
    }
  }

  private cacheKey(spec: ResolvedAgentSpec): string {
    const keyHash = spec.apiKey ? createHash('sha256').update(spec.apiKey).digest('hex').slice(0, 12) : '';
    return `${spec.agentId}::${spec.adapterId}::${spec.model ?? ''}::${spec.baseUrl ?? ''}::${keyHash}`;
  }

  private build(spec: ResolvedAgentSpec): AgentAdapter {
    const apiKey = spec.apiKey ?? this.defaultEnvKey(spec.adapterId);
    if (!apiKey && spec.adapterId !== 'mock') {
      this.log.warn(
        `No API key for adapter ${spec.adapterId} (agent ${spec.agentId}); falling back to Mock.`,
      );
      return this.wrap(new MockAdapter(), spec.agentId);
    }

    let raw: AgentAdapter;
    switch (spec.adapterId) {
      case 'mock':
        raw = new MockAdapter();
        break;

      case 'deepseek-v3':
      case 'deepseek':
        raw = new DeepSeekAdapter({
          apiKey: apiKey!,
          model: spec.model ?? 'deepseek-chat',
          baseURL: spec.baseUrl ?? undefined,
          id: spec.agentId,
        });
        break;

      case 'deepseek-r1':
        raw = new DeepSeekAdapter({
          apiKey: apiKey!,
          model: spec.model ?? 'deepseek-reasoner',
          baseURL: spec.baseUrl ?? undefined,
          id: spec.agentId,
        });
        break;

      case 'codex':
      case 'openai':
      case 'openai-compatible':
        raw = new CodexAdapter({
          apiKey: apiKey!,
          model: spec.model ?? 'gpt-4o-mini',
          baseURL: spec.baseUrl ?? undefined,
          id: spec.agentId,
        });
        break;

      case 'claude-code':
      case 'anthropic':
        raw = new ClaudeCodeAdapter({ apiKey: apiKey!, model: spec.model ?? undefined });
        break;

      case 'doubao':
        raw = new DoubaoAdapter({
          apiKey: apiKey!,
          endpoint: spec.baseUrl ?? undefined,
          model: spec.model ?? undefined,
        });
        break;

      default:
        this.log.warn(`Unknown adapterId ${spec.adapterId}; using Mock.`);
        raw = new MockAdapter();
    }

    return this.wrap(raw, spec.agentId);
  }

  private wrap(raw: AgentAdapter, _agentId: string): AgentAdapter {
    // Same middleware order as the pre-registered adapters in adapter.module.ts.
    const wrap = compose(withLogging, withLangfuse(this.tracing), withRetry({ max: 2 }));
    return wrap(raw);
  }

  private defaultEnvKey(adapterId: string): string | undefined {
    switch (adapterId) {
      case 'deepseek-v3':
      case 'deepseek-r1':
      case 'deepseek':
        return process.env.DEEPSEEK_API_KEY;
      case 'codex':
      case 'openai':
        return process.env.OPENAI_API_KEY;
      case 'claude-code':
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY;
      case 'doubao':
        return process.env.DOUBAO_API_KEY;
      case 'openai-compatible':
        // Custom endpoints have no "default" — caller MUST provide a key.
        return undefined;
      default:
        return undefined;
    }
  }
}
