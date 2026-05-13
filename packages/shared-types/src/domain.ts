/** Core domain entities — kept framework-free so web & server share identical types. */

export type ID = string;
export type ISODateTime = string;

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
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'diff'; snapshotId: ID; summary: string }
  | { kind: 'plan'; planId: ID }
  | { kind: 'preview'; sandboxId: ID; url: string; shareUrl?: string }
  | { kind: 'deploy'; deploymentId: ID; url: string; status: DeployStatus }
  | { kind: 'system'; severity: 'info' | 'warn' | 'error'; text: string };

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
