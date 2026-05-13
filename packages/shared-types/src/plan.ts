import type { ID, ISODateTime } from './domain.js';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting-critic'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface PlanTask {
  id: ID;
  goal: string;
  assigneeAgentId?: ID;             // null = not yet assigned
  inputs: ID[];                     // upstream task ids
  acceptance: AcceptanceRule[];
  status: TaskStatus;
  retries: number;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  artifactRefs?: { snapshotId?: ID; messageId?: ID };
  error?: { code: string; message: string };
}

export type AcceptanceRule =
  | { kind: 'compile' }
  | { kind: 'lint' }
  | { kind: 'test'; cmd: string }
  | { kind: 'critic-llm'; rubric: string }
  | { kind: 'manual' };

export interface Plan {
  id: ID;
  conversationId: ID;
  rootGoal: string;
  status: 'planning' | 'executing' | 'paused' | 'succeeded' | 'failed';
  tasks: PlanTask[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  version: number;                  // bumps on every edit (human or replanner)
}

/** Edits made by a human on the Plan DAG (§5.5.4). */
export type PlanEdit =
  | { op: 'add-task'; task: Omit<PlanTask, 'status' | 'retries'> }
  | { op: 'remove-task'; taskId: ID }
  | { op: 'update-task'; taskId: ID; patch: Partial<PlanTask> }
  | { op: 'add-edge'; from: ID; to: ID }
  | { op: 'remove-edge'; from: ID; to: ID };
