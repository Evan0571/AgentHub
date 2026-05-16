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
import { AdapterFactoryService } from './adapter.factory.js';
import { ADAPTER_REGISTRY } from './constants.js';

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
          registry.register(
            wrap(
              new DeepSeekAdapter({
                apiKey: process.env.DEEPSEEK_API_KEY,
                model: process.env.DEEPSEEK_FAST_MODEL ?? 'deepseek-v4-flash',
                id: 'deepseek-v4-flash',
                displayName: 'DeepSeek V4 Flash',
              }),
            ),
          );
          registry.register(
            wrap(
              new DeepSeekAdapter({
                apiKey: process.env.DEEPSEEK_API_KEY,
                model: process.env.DEEPSEEK_REASONING_MODEL ?? 'deepseek-v4-pro',
                id: 'deepseek-v4-pro',
                displayName: 'DeepSeek V4 Pro',
              }),
            ),
          );
          // Hidden compatibility aliases for old test conversations/plans.
          registry.register(
            wrap(
              new DeepSeekAdapter({
                apiKey: process.env.DEEPSEEK_API_KEY,
                model: process.env.DEEPSEEK_FAST_MODEL ?? 'deepseek-v4-flash',
                id: 'deepseek-v3',
                displayName: 'DeepSeek V4 Flash',
              }),
            ),
          );
          registry.register(
            wrap(
              new DeepSeekAdapter({
                apiKey: process.env.DEEPSEEK_API_KEY,
                model: process.env.DEEPSEEK_REASONING_MODEL ?? 'deepseek-v4-pro',
                id: 'deepseek-r1',
                displayName: 'DeepSeek V4 Pro',
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
    AdapterFactoryService,
  ],
  exports: [ADAPTER_REGISTRY, AdapterFactoryService],
})
export class AdapterModule {}

export { ADAPTER_REGISTRY };
