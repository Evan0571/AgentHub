import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';

/**
 * Durable, structured project memory persisted at `.agenthub/state.json` in
 * the conversation workspace. Survives across agent invocations / restarts so
 * the project "doesn't lose its mind" mid-build. Read into every executing
 * agent's system prompt; appended to as tasks finish.
 *
 * `summary` is a rolling, compacted narrative — the place older context gets
 * folded into when the raw transcript would blow the window (Cursor/Codex
 * style compaction). Compaction is best-effort and fail-open.
 */
export interface ProjectState {
  goal: string;
  summary: string;
  decisions: string[];
  done: string[];
  blocked: string[];
  updatedAt: string;
}

const STATE_PATH = '.agenthub/state.json';

function emptyState(): ProjectState {
  return { goal: '', summary: '', decisions: [], done: [], blocked: [], updatedAt: '' };
}

@Injectable()
export class ProjectStateService {
  private readonly log = new Logger('ProjectState');

  constructor(private readonly workspace: WorkspaceService) {}

  async load(conversationId: string): Promise<ProjectState> {
    try {
      const r = await this.workspace.readFile(conversationId, { path: STATE_PATH, maxBytes: 64_000 });
      const parsed = JSON.parse(r.content) as Partial<ProjectState>;
      return { ...emptyState(), ...parsed };
    } catch {
      return emptyState();
    }
  }

  async save(conversationId: string, state: ProjectState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    try {
      await this.workspace.writeFile(conversationId, {
        path: STATE_PATH,
        content: JSON.stringify(state, null, 2),
      });
    } catch (e) {
      this.log.warn(`save failed: ${(e as Error).message}`);
    }
  }

  async setGoalIfEmpty(conversationId: string, goal: string): Promise<void> {
    const s = await this.load(conversationId);
    if (!s.goal && goal.trim()) {
      s.goal = goal.trim().slice(0, 600);
      await this.save(conversationId, s);
    }
  }

  /** Record a task outcome. Keeps the lists bounded (most recent kept). */
  async recordOutcome(
    conversationId: string,
    outcome: { kind: 'done' | 'blocked'; taskId: string; goal: string; note?: string },
  ): Promise<void> {
    const s = await this.load(conversationId);
    const line = `${outcome.taskId} · ${outcome.goal}${outcome.note ? ` — ${outcome.note}` : ''}`.slice(0, 240);
    if (outcome.kind === 'done') {
      s.done = dedupeTail([...s.done, line], 30);
      s.blocked = s.blocked.filter((b) => !b.startsWith(outcome.taskId + ' '));
    } else {
      s.blocked = dedupeTail([...s.blocked, line], 20);
    }
    await this.save(conversationId, s);
  }

  async addDecision(conversationId: string, decision: string): Promise<void> {
    const s = await this.load(conversationId);
    s.decisions = dedupeTail([...s.decisions, decision.trim().slice(0, 240)], 25);
    await this.save(conversationId, s);
  }

  /** Compact block injected into agent system prompts. */
  renderForPrompt(s: ProjectState): string {
    if (!s.goal && !s.summary && s.done.length === 0 && s.blocked.length === 0) return '';
    const parts: string[] = ['## 项目状态（持久记忆，跨 Agent 共享）'];
    if (s.goal) parts.push(`**目标**：${s.goal}`);
    if (s.summary) parts.push(`**进展摘要**：${s.summary}`);
    if (s.decisions.length) parts.push(`**关键决策**：\n${s.decisions.slice(-8).map((d) => `- ${d}`).join('\n')}`);
    if (s.done.length) parts.push(`**已完成**：\n${s.done.slice(-10).map((d) => `- ${d}`).join('\n')}`);
    if (s.blocked.length) parts.push(`**当前阻塞**：\n${s.blocked.slice(-6).map((d) => `- ${d}`).join('\n')}`);
    return parts.join('\n\n');
  }

  /**
   * Fold older raw transcript + current state into `summary` so context stays
   * bounded. Caller supplies a one-shot summarizer (a cheap LLM call); this
   * method only decides WHEN and stores the result. Fail-open: on any error
   * the old summary is kept untouched.
   */
  async compact(
    conversationId: string,
    transcript: string,
    summarize: (input: string) => Promise<string>,
  ): Promise<void> {
    // Only compact when there is enough new material to be worth a call.
    if (transcript.length < 3000) return;
    const s = await this.load(conversationId);
    const input =
      `已有摘要：\n${s.summary || '(空)'}\n\n` +
      `目标：${s.goal || '(未定)'}\n\n` +
      `需要折叠进摘要的对话/进展：\n${transcript.slice(-12_000)}`;
    try {
      const next = await summarize(input);
      if (next && next.trim()) {
        s.summary = next.trim().slice(0, 2000);
        await this.save(conversationId, s);
      }
    } catch (e) {
      this.log.warn(`compact skipped: ${(e as Error).message}`);
    }
  }
}

function dedupeTail(arr: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out.slice(-max);
}
