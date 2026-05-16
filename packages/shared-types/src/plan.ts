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
  /** Longer planning note shown in the Plan panel and mirrored to TASKS.md. */
  details?: string;
  deliverables?: string[];
  checklist?: string[];
  assigneeAgentId?: ID;             // null = not yet assigned
  inputs: ID[];                     // upstream task ids
  acceptance: AcceptanceRule[];
  status: TaskStatus;
  retries: number;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  artifactRefs?: { snapshotId?: ID; messageId?: ID };
  error?: { code: string; message: string };
  /**
   * Captured agent reply text. Used to feed downstream tasks the real code
   * their predecessors produced — without it, agents writing the entry file
   * have no idea what exports the components above produced.
   */
  outputText?: string;
  /**
   * Most recent Critic feedback when retrying. Prepended to the next attempt's
   * user message so the agent can self-correct rather than reproduce the bug.
   */
  criticFeedback?: string;
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
