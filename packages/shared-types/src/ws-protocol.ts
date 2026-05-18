import type { ID, ISODateTime, Message, MessageContent } from './domain.js';
import type { Plan, PlanEdit } from './plan.js';

export type AgentRuntimeState =
  | 'running'
  | 'waiting_user'
  | 'blocked'
  | 'idle'
  | 'failed';

export interface UserQuestionOption {
  id: ID;
  label: string;
  description: string;
  recommended?: boolean;
  preview?: string;
}

export interface UserQuestion {
  id: ID;
  header: string;
  question: string;
  options: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionRequest {
  id: ID;
  conversationId: ID;
  sourceAgentId?: ID;
  sourceAgentName: string;
  title: string;
  reason?: string;
  questions: UserQuestion[];
  resumePrompt: string;
  createdAt: ISODateTime;
}

export interface UserQuestionAnswer {
  questionId: ID;
  question: string;
  answer: string;
  optionIds: ID[];
  notes?: string;
}

/** Client → Server */
export type ClientEvent =
  | { op: 'user_msg'; conversationId: ID; content: MessageContent; mentions: ID[]; replyToId?: ID; clientEventId?: string }
  | { op: 'answer_user_question'; conversationId: ID; requestId: ID; answers: UserQuestionAnswer[]; resumePrompt: string }
  | { op: 'cancel'; taskId: ID }
  | { op: 'accept_patch'; snapshotId: ID; hunkIds: string[] }
  | { op: 'reject_patch'; snapshotId: ID; hunkIds: string[] }
  | { op: 'edit_plan'; planId: ID; edits: PlanEdit[]; baseVersion: number }
  | { op: 'retry_task'; planId: ID; taskId: ID }
  | { op: 'pause_plan'; planId: ID }
  | { op: 'resume_plan'; planId: ID }
  | { op: 'suggest_deps'; planId: ID; requestId: string; newGoal: string }
  | { op: 'deploy'; conversationId: ID; target: 'vercel' | 'mock'; html: string; projectName?: string }
  | { op: 'replay_request'; conversationId: ID; sinceMessageId?: ID; speed?: number };

/** Server → Client */
export type ServerEvent =
  | { op: 'client_event_ack'; clientEventId: string }
  | { op: 'ask_user_question'; request: UserQuestionRequest }
  | {
      op: 'agent_state';
      conversationId: ID;
      agentId?: ID;
      agentName: string;
      msgId?: ID;
      state: AgentRuntimeState;
      reason?: string;
      updatedAt: ISODateTime;
    }
  | { op: 'msg_started'; message: Pick<Message, 'id' | 'conversationId' | 'senderType' | 'senderId' | 'createdAt' | 'replyToId'> }
  | { op: 'msg_token'; msgId: ID; delta: string }
  | { op: 'msg_thinking'; msgId: ID; delta: string }
  | { op: 'msg_done'; msgId: ID; usage?: TokenUsage }
  | { op: 'msg_error'; msgId: ID; error: ErrorPayload }
  | { op: 'msg_recall'; msgId: ID }
  | { op: 'patch'; msgId: ID; snapshotId: ID; files: FileDiffSummary[] }
  | {
      op: 'agent_activity';
      activityId: ID;
      conversationId: ID;
      msgId: ID;
      agentId?: ID;
      agentName: string;
      kind: 'workspace' | 'terminal' | 'file' | 'stream';
      toolName?: string;
      status: 'running' | 'succeeded' | 'failed';
      title: string;
      detail?: string;
      createdAt: ISODateTime;
    }
  | { op: 'plan_update'; plan: Plan }
  | { op: 'plan_conflict'; planId: ID; serverVersion: number; clientVersion: number }
  | { op: 'dep_suggestion'; planId: ID; requestId: string; suggestedInputs: ID[]; reasoning?: string }
  | { op: 'dep_suggestion_error'; planId: ID; requestId: string; message: string }
  | { op: 'preview_ready'; sandboxId: ID; url: string; shareUrl?: string }
  | { op: 'preview_log'; sandboxId: ID; stream: 'stdout' | 'stderr'; line: string }
  | {
      op: 'deploy_status';
      deploymentId: ID;
      conversationId: ID;
      target: 'vercel' | 'mock';
      status: 'queued' | 'building' | 'ready' | 'failed' | 'rolled-back';
      url?: string;
      errorMessage?: string;
      createdAt: ISODateTime;
    }
  | { op: 'replay_frame'; frame: ReplayFrame }
  | {
      op: 'agent_terminal';
      conversationId: ID;
      agentName: string;
      command: string;
      cwd: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
      createdAt: ISODateTime;
    }
  | { op: 'error'; code: string; message: string; retryable: boolean };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  latencyMs: number;
}

export interface ErrorPayload {
  code:
    | 'RATE_LIMITED'
    | 'CONTEXT_OVERFLOW'
    | 'TOOL_UNAVAILABLE'
    | 'UPSTREAM_4XX'
    | 'UPSTREAM_5XX'
    | 'AUTH'
    | 'CANCELLED'
    | 'INTERNAL'
    | (string & {});
  message: string;
  retryable: boolean;
}

export interface FileDiffSummary {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  hunks: { id: string; header: string }[];
}

/** Replay timeline frame for §F2.7 group chat replay. */
export type ReplayFrame =
  | { kind: 'msg'; message: Message }
  | { kind: 'plan'; plan: Plan }
  | { kind: 'patch'; snapshotId: ID; files: FileDiffSummary[] }
  | { kind: 'deploy'; deploymentId: ID; status: string }
  | { kind: 'done' };
