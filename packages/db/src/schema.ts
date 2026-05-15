import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  pgEnum,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/** Mirrors PRD §7 data model. */

export const conversationType = pgEnum('conversation_type', ['single', 'group']);
export const senderType = pgEnum('sender_type', ['user', 'agent', 'system']);
export const memberRole = pgEnum('member_role', ['admin', 'member', 'muted']);
export const taskStatus = pgEnum('task_status', [
  'pending',
  'ready',
  'running',
  'awaiting-critic',
  'succeeded',
  'failed',
  'cancelled',
]);
export const planStatus = pgEnum('plan_status', [
  'planning',
  'executing',
  'paused',
  'succeeded',
  'failed',
]);
export const deployStatus = pgEnum('deploy_status', [
  'queued',
  'building',
  'ready',
  'failed',
  'rolled-back',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),                       // claude-code | codex | doubao
  secretEncrypted: text('secret_encrypted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  // text not uuid: built-in agents use stable slug ids ('deepseek-v3',
  // 'orchestrator', ...) so they survive re-seeding meaningfully.
  // Custom user agents still get crypto.randomUUID() at the application layer.
  id: text('id').primaryKey(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  adapterId: text('adapter_id').notNull(),
  model: text('model'),
  systemPrompt: text('system_prompt').notNull(),
  avatarColor: text('avatar_color').notNull().default('#6366f1'),
  isPublic: boolean('is_public').notNull().default(false),
  // BYOK (bring-your-own-key): user-supplied API key for this agent's backing
  // provider, AES-256-GCM ciphertext (see apps/server/src/crypto). Nullable
  // — when null, the server uses its env-configured fallback key.
  apiKeyEncrypted: text('api_key_encrypted'),
  // Custom OpenAI-compatible endpoint base URL (Ollama, vLLM, OneAPI, Groq).
  // Only meaningful when adapterId === 'openai-compatible' (or user wants
  // to override an official provider's default endpoint).
  baseUrl: text('base_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: conversationType('type').notNull(),
  title: text('title').notNull(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  groupSystemPrompt: text('group_system_prompt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Matches agents.id (text).
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.agentId] }),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: senderType('sender_type').notNull(),
    // text not uuid: senders can be a user UUID, an agent string id
    // (e.g. 'deepseek-v3'), or 'orchestrator' / 'system'.
    senderId: text('sender_id').notNull(),
    contentType: text('content_type').notNull(),
    body: jsonb('body').notNull(),
    mentions: jsonb('mentions').notNull().default([]),
    replyToId: uuid('reply_to_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    convIdx: index('messages_conv_created_idx').on(t.conversationId, t.createdAt),
  }),
);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' })
    .unique(),
  headSnapshotId: uuid('head_snapshot_id'),
});

export const snapshots = pgTable('snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  messageId: uuid('message_id'),
  filesRef: text('files_ref').notNull(),                       // s3 key or local path
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  rootGoal: text('root_goal').notNull(),
  status: planStatus('status').notNull().default('planning'),
  dag: jsonb('dag').notNull(),                                  // serialized Plan
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  goal: text('goal').notNull(),
  assigneeAgentId: text('assignee_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
  status: taskStatus('status').notNull().default('pending'),
  acceptance: jsonb('acceptance').notNull().default([]),
  retries: integer('retries').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: jsonb('error'),
});

export const agentCalls = pgTable('agent_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  adapterId: text('adapter_id').notNull(),
  model: text('model'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costUsd: integer('cost_usd_centi').notNull().default(0),    // store *10000 to avoid floats
  latencyMs: integer('latency_ms').notNull().default(0),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  spanId: text('span_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  snapshotId: uuid('snapshot_id'),
  target: text('target').notNull(),                            // vercel | cloudflare | docker
  url: text('url'),
  status: deployStatus('status').notNull().default('queued'),
  logRef: text('log_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sandboxes = pgTable('sandboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  url: text('url'),
  shareToken: text('share_token'),                              // signed JWT for F7.6
  shareExpiresAt: timestamp('share_expires_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: text('status').notNull().default('starting'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
