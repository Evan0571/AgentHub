/** Core domain entities — kept framework-free so web & server share identical types. */

export type ID = string;
export type ISODateTime = string;

/**
 * Synthetic mention that routes a message to the project Orchestrator/Planner
 * instead of a single agent. Not a real agent row — both the web client
 * (intent inference) and the server (mention router) special-case it, so it
 * lives here to stay in sync.
 */
export const PROJECT_PLANNER_MENTION = 'project-planner';

export type ConversationType = 'single' | 'group';

export interface Conversation {
  id: ID;
  type: ConversationType;
  title: string;
  ownerUserId: ID;
  memberAgentIds: ID[];
  groupSystemPrompt?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface AgentProfile {
  id: ID;
  name: string;
  adapterId: string;                  // matches AgentAdapter.id (claude-code, codex, doubao, mock)
  model?: string;
  systemPrompt: string;
  avatarColor: string;
  capabilities: {
    streaming: boolean;
    toolUse: boolean;
    codeExecution: boolean;
    fileEdit: boolean;
    webBrowse: boolean;
    maxContextTokens: number;
  };
}

export type SenderType = 'user' | 'agent' | 'system';

export type MessageContent =
  | { kind: 'text'; text: string; attachments?: MessageAttachment[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'diff'; snapshotId: ID; summary: string }
  | { kind: 'plan'; planId: ID }
  | { kind: 'preview'; sandboxId: ID; url: string; shareUrl?: string }
  | { kind: 'deploy'; deploymentId: ID; url: string; status: DeployStatus }
  | { kind: 'system'; severity: 'info' | 'warn' | 'error'; text: string };

export interface MessageAttachment {
  id: ID;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'file';
}

export interface Message {
  id: ID;
  conversationId: ID;
  senderType: SenderType;
  senderId: ID;                       // userId or agentId
  content: MessageContent;
  mentions: ID[];                     // agentIds that were @-mentioned
  replyToId?: ID;
  createdAt: ISODateTime;
  deletedAt?: ISODateTime;            // soft delete (recall)
}

export type DeployStatus = 'queued' | 'building' | 'ready' | 'failed' | 'rolled-back';

export interface Snapshot {
  id: ID;
  workspaceId: ID;
  parentId?: ID;
  messageId?: ID;
  filesRef: string;                   // S3 key or local path
  createdAt: ISODateTime;
}

export interface Workspace {
  id: ID;
  conversationId: ID;
  headSnapshotId?: ID;
}
