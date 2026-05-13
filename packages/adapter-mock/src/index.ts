import type {
  AgentAdapter,
  ChatRequest,
  ChatEvent,
  CostEstimate,
  HealthStatus,
} from '@agenthub/adapter-core';

/**
 * Mock adapter — streams a canned response token-by-token.
 * Use it for:
 *  1) Unit / E2E tests that should not burn API tokens.
 *  2) Demo fallback when real provider keys are missing / rate-limited.
 *
 * Behavior is deterministic but can be steered via `metadata.mockScript`:
 *   { kind: 'text', text: 'hello' }
 *   { kind: 'patch', path: 'a.ts', diff: '...' }
 *   { kind: 'error', code: 'RATE_LIMITED' }
 */

type MockScriptStep =
  | { kind: 'text'; text: string }
  | { kind: 'patch'; path: string; diff: string }
  | { kind: 'tool_call'; name: string; args: unknown }
  | { kind: 'error'; code: 'RATE_LIMITED' | 'UPSTREAM_5XX' | 'CONTEXT_OVERFLOW'; retryable: boolean };

const DEFAULT_SCRIPT: MockScriptStep[] = [
  { kind: 'text', text: '收到，我来处理。\n\n' },
  { kind: 'text', text: '## 计划\n1. 分析需求\n2. 编写代码\n3. 自检\n\n' },
  {
    kind: 'patch',
    path: 'src/hello.ts',
    diff: `--- a/src/hello.ts
+++ b/src/hello.ts
@@ -0,0 +1,3 @@
+export function hello(name: string) {
+  return \`hello, \${name}\`;
+}
`,
  },
  { kind: 'text', text: '\n已完成，欢迎 review。' },
];

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly displayName = 'Mock (offline demo)';
  readonly capabilities = {
    streaming: true,
    toolUse: true,
    codeExecution: false,
    fileEdit: true,
    webBrowse: false,
    maxContextTokens: 200_000,
    supportedLangs: ['zh', 'en'],
  };

  private readonly tokenIntervalMs: number;

  constructor(opts: { tokenIntervalMs?: number } = {}) {
    this.tokenIntervalMs = opts.tokenIntervalMs ?? 30;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const script =
      (req.metadata?.mockScript as MockScriptStep[] | undefined) ?? DEFAULT_SCRIPT;
    const t0 = Date.now();
    let completionTokens = 0;

    for (const step of script) {
      if (signal?.aborted) {
        yield {
          type: 'error',
          error: { code: 'CANCELLED', message: 'aborted', retryable: false },
        };
        return;
      }

      if (step.kind === 'text') {
        for (const chunk of chunkText(step.text)) {
          if (signal?.aborted) return;
          await sleep(this.tokenIntervalMs);
          completionTokens += chunk.length;
          yield { type: 'token', text: chunk };
        }
      } else if (step.kind === 'patch') {
        await sleep(this.tokenIntervalMs * 4);
        yield { type: 'file_patch', path: step.path, diff: step.diff };
      } else if (step.kind === 'tool_call') {
        yield {
          type: 'tool_call',
          call: { id: `mock-${Date.now()}`, name: step.name, args: step.args },
        };
      } else if (step.kind === 'error') {
        yield {
          type: 'error',
          error: { code: step.code, message: 'mock error', retryable: step.retryable },
        };
        return;
      }
    }

    yield {
      type: 'done',
      finishReason: 'stop',
      usage: {
        promptTokens: estimateTokens(req),
        completionTokens,
        costUsd: 0,
        latencyMs: Date.now() - t0,
      },
    };
  }

  async cancel(_taskId: string): Promise<void> {
    /* AbortController handles cancellation; nothing to do here. */
  }

  estimateCost(req: ChatRequest): CostEstimate {
    return { estimatedCostUsd: 0, promptTokens: estimateTokens(req) };
  }

  async health(): Promise<HealthStatus> {
    return { ok: true, latencyMs: 0, notes: 'mock is always healthy' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkText(text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function estimateTokens(req: ChatRequest): number {
  const total = req.messages.reduce((acc, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return acc + s.length;
  }, 0);
  return Math.ceil(total / 4);
}
