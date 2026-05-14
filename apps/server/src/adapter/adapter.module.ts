import { Global, Module } from '@nestjs/common';
import {
  AdapterRegistry,
  compose,
  withLogging,
  withRetry,
} from '@agenthub/adapter-core';
import { MockAdapter } from '@agenthub/adapter-mock';
import { ClaudeCodeAdapter } from '@agenthub/adapter-claude-code';
import { CodexAdapter } from '@agenthub/adapter-codex';
import { DeepSeekAdapter } from '@agenthub/adapter-deepseek';
import { DoubaoAdapter } from '@agenthub/adapter-doubao';
import { TracingService } from '../observability/tracing.service.js';
import { withLangfuse } from '../observability/adapter-tracing.js';

const ADAPTER_REGISTRY = 'ADAPTER_REGISTRY';

@Global()
@Module({
  providers: [
    {
      provide: ADAPTER_REGISTRY,
      inject: [TracingService],
      useFactory: (tracing: TracingService) => {
        const registry = new AdapterRegistry();
        // Order matters: langfuse OUTSIDE retry so retried calls each show as
        // separate generations; logging OUTSIDE everything for full visibility.
        const wrap = compose(withLogging, withLangfuse(tracing), withRetry({ max: 2 }));

        // Mock is always available (zero-config demo fallback).
        registry.register(wrap(new MockAdapter()));

        if (process.env.DEEPSEEK_API_KEY) {
          // Register V3 and R1 side-by-side; Orchestrator picks by capability/role.
          registry.register(
            wrap(
              new DeepSeekAdapter({
                apiKey: process.env.DEEPSEEK_API_KEY,
                model: 'deepseek-chat',
              }),
            ),
          );
          registry.register(
            wrap(
              new DeepSeekAdapter({
                apiKey: process.env.DEEPSEEK_API_KEY,
                model: 'deepseek-reasoner',
              }),
            ),
          );
        }
        if (process.env.ANTHROPIC_API_KEY) {
          registry.register(wrap(new ClaudeCodeAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })));
        }
        if (process.env.OPENAI_API_KEY) {
          registry.register(wrap(new CodexAdapter({ apiKey: process.env.OPENAI_API_KEY })));
        }
        if (process.env.DOUBAO_API_KEY) {
          registry.register(
            wrap(
              new DoubaoAdapter({
                apiKey: process.env.DOUBAO_API_KEY,
                endpoint: process.env.DOUBAO_ENDPOINT,
              }),
            ),
          );
        }

        console.log(
          `[AdapterRegistry] registered: ${registry.list().map((a) => a.id).join(', ')}`,
        );

        return registry;
      },
    },
  ],
  exports: [ADAPTER_REGISTRY],
})
export class AdapterModule {}

export { ADAPTER_REGISTRY };
