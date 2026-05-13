import { Injectable } from '@nestjs/common';
import type { Plan, PlanEdit, PlanTask } from '@agenthub/shared-types';

type ApplyResult =
  | { kind: 'ok'; plan: Plan }
  | { kind: 'conflict'; serverVersion: number };

/**
 * Plan persistence + human DAG edits (PRD §5.5.4).
 * Optimistic concurrency: client sends baseVersion; server rejects on mismatch.
 */
@Injectable()
export class PlanService {
  private readonly plans = new Map<string, Plan>();

  async save(plan: Plan): Promise<void> {
    this.plans.set(plan.id, plan);
  }

  async get(id: string): Promise<Plan | undefined> {
    return this.plans.get(id);
  }

  async setStatus(planId: string, status: Plan['status']): Promise<void> {
    const p = this.plans.get(planId);
    if (!p) return;
    p.status = status;
    p.updatedAt = new Date().toISOString();
    p.version++;
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
