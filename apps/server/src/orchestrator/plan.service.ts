import { Injectable, Logger } from '@nestjs/common';
import type { Plan, PlanEdit, PlanTask } from '@agenthub/shared-types';
import { PlansRepo } from '../db/plans.repo.js';

type ApplyResult =
  | { kind: 'ok'; plan: Plan }
  | { kind: 'conflict'; serverVersion: number };

type RetryTaskResult =
  | { kind: 'ok'; plan: Plan }
  | { kind: 'not_found'; message: string }
  | { kind: 'not_retryable'; plan: Plan; message: string };

/**
 * Plan persistence + human DAG edits (PRD §5.5.4).
 * Optimistic concurrency: client sends baseVersion; server rejects on mismatch.
 *
 * In-memory cache is the source of truth for live execution (avoids round
 * trips on every status flip); the DB is the durable copy for hydration.
 */
@Injectable()
export class PlanService {
  private readonly log = new Logger('PlanService');
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly repo: PlansRepo) {}

  async save(plan: Plan): Promise<void> {
    this.plans.set(plan.id, plan);
    // Persist asynchronously — don't block hot path on DB.
    void this.repo.upsert(plan).catch((e) => {
      this.log.warn(`persist plan ${plan.id} failed: ${(e as Error).message}`);
    });
  }

  async get(id: string): Promise<Plan | undefined> {
    const cached = this.plans.get(id);
    if (cached) return cached;
    const fromDb = await this.repo.getById(id);
    if (fromDb) this.plans.set(id, fromDb);
    return fromDb;
  }

  /** Find the latest plan for a conversation (used for hydration). */
  async latestForConversation(conversationSlugOrUuid: string): Promise<Plan | undefined> {
    const cached = [...this.plans.values()]
      .filter((p) => p.conversationId === conversationSlugOrUuid)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (cached) return cached;

    const fromDb = await this.repo.latestForConversation(conversationSlugOrUuid);
    if (fromDb) this.plans.set(fromDb.id, fromDb);
    return fromDb;
  }

  async setStatus(planId: string, status: Plan['status']): Promise<void> {
    const p = this.plans.get(planId);
    if (!p) return;
    p.status = status;
    p.updatedAt = new Date().toISOString();
    p.version++;
    void this.repo.upsert(p).catch((e) => {
      this.log.warn(`persist plan ${p.id} failed: ${(e as Error).message}`);
    });
  }

  async applyEdits(planId: string, edits: PlanEdit[], baseVersion: number): Promise<ApplyResult> {
    const p = this.plans.get(planId);
    if (!p) return { kind: 'conflict', serverVersion: 0 };
    if (p.version !== baseVersion) return { kind: 'conflict', serverVersion: p.version };

    for (const edit of edits) {
      switch (edit.op) {
        case 'add-task':
          p.tasks.push({ ...edit.task, status: 'pending', retries: 0 } as PlanTask);
          break;
        case 'remove-task':
          p.tasks = p.tasks.filter((t) => t.id !== edit.taskId);
          for (const t of p.tasks) t.inputs = t.inputs.filter((i) => i !== edit.taskId);
          break;
        case 'update-task': {
          const t = p.tasks.find((x) => x.id === edit.taskId);
          if (t) Object.assign(t, edit.patch);
          break;
        }
        case 'add-edge': {
          const t = p.tasks.find((x) => x.id === edit.to);
          if (t && !t.inputs.includes(edit.from)) t.inputs.push(edit.from);
          break;
        }
        case 'remove-edge': {
          const t = p.tasks.find((x) => x.id === edit.to);
          if (t) t.inputs = t.inputs.filter((i) => i !== edit.from);
          break;
        }
      }
    }

    if (hasCycle(p)) return { kind: 'conflict', serverVersion: p.version };

    p.version++;
    p.updatedAt = new Date().toISOString();
    void this.repo.upsert(p).catch((e) => {
      this.log.warn(`persist plan ${p.id} failed: ${(e as Error).message}`);
    });
    return { kind: 'ok', plan: p };
  }

  async retryTask(planId: string, taskId: string): Promise<RetryTaskResult> {
    const p = await this.get(planId);
    if (!p) return { kind: 'not_found', message: `plan not found: ${planId}` };

    const task = p.tasks.find((t) => t.id === taskId);
    if (!task) return { kind: 'not_found', message: `task not found: ${taskId}` };

    if (task.status === 'running' || task.status === 'awaiting-critic') {
      return { kind: 'not_retryable', plan: p, message: `${taskId} is already running` };
    }
    if (task.status !== 'failed' && task.status !== 'cancelled') {
      return { kind: 'not_retryable', plan: p, message: `${taskId} is ${task.status}, not failed` };
    }

    const previousError = task.error;
    task.status = 'pending';
    task.retries = (task.retries ?? 0) + 1;
    task.startedAt = undefined;
    task.finishedAt = undefined;
    task.artifactRefs = undefined;
    task.outputText = undefined;
    task.error = undefined;
    task.criticFeedback = previousError
      ? `Previous failure: ${previousError.code}: ${previousError.message}`
      : task.criticFeedback;

    p.status = 'executing';
    p.version++;
    p.updatedAt = new Date().toISOString();
    this.plans.set(p.id, p);
    await this.repo.upsert(p).catch((e) => {
      this.log.warn(`persist plan ${p.id} failed: ${(e as Error).message}`);
    });
    return { kind: 'ok', plan: p };
  }
}

function hasCycle(plan: Plan): boolean {
  const adj = new Map<string, string[]>();
  for (const t of plan.tasks) adj.set(t.id, t.inputs);
  const color = new Map<string, 0 | 1 | 2>();
  const dfs = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) return true;
      if (c === 0 && dfs(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const t of plan.tasks) if ((color.get(t.id) ?? 0) === 0 && dfs(t.id)) return true;
  return false;
}
