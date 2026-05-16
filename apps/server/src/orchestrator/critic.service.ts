import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { PlanTask } from '@agenthub/shared-types';
import { critic as criticPrompt } from '@agenthub/prompts';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';

export interface CriticVerdict {
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
  suggestedReplan?: { scope: 'this-task' | 'downstream'; hint: string };
}

interface RawVerdict {
  verdict?: unknown;
  reasons?: unknown;
  suggestedReplan?: unknown;
}

/**
 * LLM-backed quality gate. Called by the Executor after each task finishes.
 * Default bias is **lenient** — only flag obvious problems (empty output,
 * broken code, off-topic). The goal is helpful self-correction, not strict
 * code review.
 */
@Injectable()
export class CriticService {
  private readonly log = new Logger('CriticService');

  constructor(@Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry) {}

  async judge(task: PlanTask, output: string): Promise<CriticVerdict> {
    // Fast-path: empty agent reply is an unambiguous failure; skip LLM call.
    const trimmed = output.trim();
    if (trimmed.length < 50 && !/```/.test(trimmed)) {
      return {
        verdict: 'FAIL',
        reasons: ['agent 产出几乎为空（< 50 字符且无代码块）'],
        suggestedReplan: { scope: 'this-task', hint: '重试前在 user prompt 中强调"必须产出可用结果"' },
      };
    }

    const adapter = this.pickAdapter();
    if (!adapter) {
      // No critic adapter available — fail-open (default PASS) so we don't
      // block the pipeline on a missing config.
      return { verdict: 'PASS', reasons: ['critic 未配置 LLM adapter，默认通过'] };
    }

    const userMsg =
      `任务目标：${task.goal}\n\n` +
      `验收规则：${task.acceptance.map((a) => a.kind).join(' / ') || 'manual'}\n\n` +
      `Agent 的回复（截断 ≤ 2000 字符）：\n` +
      `---\n${truncate(trimmed, 2000)}\n---\n\n` +
      `请评估该回复是否达成目标。`;

    const req: ChatRequest = {
      taskId: 'critic-' + task.id,
      metadata: { purpose: 'critic', taskId: task.id },
      systemPrompt: criticPrompt.systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      budget: { maxTokens: 300 },
    };

    // Hard timeout: the critic is a separate LLM call NOT covered by the
    // tool-runner watchdog. Without this, a hung critic leaves the task
    // stuck in `awaiting-critic` forever. Fail-open (PASS) on timeout so the
    // pipeline keeps moving rather than dead-locking.
    const ctrl = new AbortController();
    const timeoutMs = criticTimeoutMs();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let raw = '';
    try {
      for await (const ev of adapter.chat(req, ctrl.signal)) {
        if (ev.type === 'token') raw += ev.text;
        if (ev.type === 'error') {
          this.log.warn(`critic adapter error: ${ev.error.message}`);
          return { verdict: 'PASS', reasons: ['critic LLM 错误，默认通过'] };
        }
      }
    } catch (e) {
      const why = ctrl.signal.aborted
        ? `critic ${Math.round(timeoutMs / 1000)}s 超时，默认通过`
        : 'critic 调用异常，默认通过';
      this.log.warn(`critic adapter ${ctrl.signal.aborted ? 'timed out' : 'threw'}: ${(e as Error).message}`);
      return { verdict: 'PASS', reasons: [why] };
    } finally {
      clearTimeout(timer);
    }

    const parsed = extractJsonObject(raw);
    if (!parsed) {
      this.log.warn(`critic could not parse JSON: ${raw.slice(0, 120)}`);
      return { verdict: 'PASS', reasons: ['critic 输出无法解析，默认通过'] };
    }

    const verdict = parsed.verdict === 'FAIL' ? 'FAIL' : 'PASS';
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 5)
      : [];
    const replan = isReplan(parsed.suggestedReplan) ? parsed.suggestedReplan : undefined;

    return {
      verdict,
      reasons,
      ...(verdict === 'FAIL' && replan ? { suggestedReplan: replan } : {}),
    };
  }

  private pickAdapter() {
    // Always prefer a fast cheap model for the critic — it's a tight loop.
    for (const id of ['deepseek-v4-flash', 'deepseek-v3', 'codex', 'doubao', 'mock']) {
      if (this.registry.has(id)) return this.registry.get(id);
    }
    return undefined;
  }
}

function criticTimeoutMs(): number {
  const raw = Number(process.env.AGENTHUB_CRITIC_TIMEOUT_MS ?? 45_000);
  if (!Number.isFinite(raw)) return 45_000;
  return Math.max(10_000, Math.min(180_000, Math.trunc(raw)));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractJsonObject(text: string): RawVerdict | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as RawVerdict;
  } catch {
    return null;
  }
}

function isReplan(v: unknown): v is { scope: 'this-task' | 'downstream'; hint: string } {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    (obj.scope === 'this-task' || obj.scope === 'downstream') &&
    typeof obj.hint === 'string'
  );
}
