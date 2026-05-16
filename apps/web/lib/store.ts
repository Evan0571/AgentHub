'use client';

import { create } from 'zustand';
import { type ServerEvent, type Plan, type PlanEdit, type MessageAttachment, PROJECT_PLANNER_MENTION } from '@agenthub/shared-types';
import { AgentHubWS } from './ws-client';

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  /** Underlying provider (e.g. `deepseek-v4-flash`, `codex`) — drives the brand logo avatar. */
  adapterId?: string;
  avatarColor?: string;
  text: string;
  attachments?: MessageAttachment[];
  thinking?: string;
  streaming?: boolean;
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  adapterId: string;
  model: string | null;
  baseUrl: string | null;
  /** Server never returns the raw key; only whether one is stored. */
  hasApiKey: boolean;
  systemPrompt: string;
  avatarColor: string;
  isPublic: boolean;
  ownerUserId: string | null;
}

export const HIDDEN_SYSTEM_AGENT_IDS = new Set(['mock', 'orchestrator']);

export function isHiddenSystemAgentId(id: string): boolean {
  return HIDDEN_SYSTEM_AGENT_IDS.has(id);
}

export function isConversationScopedAgentId(id: string): boolean {
  return id.startsWith('conv-agent-');
}

/**
 * conv-agent ids look like `conv-agent-<36charUUID>-<baseRoleId>`. The base
 * role agent (e.g. `solution-architect`) is a public seeded agent that IS in
 * the client list, so we can borrow its display name/color even though the
 * per-conversation clone isn't fetched into `state.agents`.
 */
export function baseRoleIdFromConvAgent(id: string): string | null {
  if (!id.startsWith('conv-agent-')) return null;
  const rest = id.slice('conv-agent-'.length);
  const m = /^[0-9a-fA-F-]{36}-(.+)$/.exec(rest);
  return m?.[1] ?? null;
}

export interface ChatConversation {
  id: string;
  title: string;
  type: 'single' | 'group';
  groupSystemPrompt?: string | null;
  members: {
    agentId: string;
    name: string;
    adapterId: string;
    avatarColor: string;
    role: 'admin' | 'member' | 'muted';
  }[];
  /** For single chats: which member to invoke by default. */
  targetAgentId?: string;
  preview?: string;
}

export type RightPanelTab = 'workspace' | 'plan' | 'preview' | 'deploy';

export interface Deployment {
  deploymentId: string;
  conversationId: string;
  target: 'vercel' | 'mock';
  status: 'queued' | 'building' | 'ready' | 'failed' | 'rolled-back';
  url?: string;
  errorMessage?: string;
  createdAt: string;
}

interface State {
  conversations: ChatConversation[];
  agents: AgentProfile[];
  activeId: string | null;
  messagesByConv: Record<string, ChatMessage[]>;
  plansByConv: Record<string, Plan>;
  deploymentsByConv: Record<string, Deployment[]>;
  rightPanelTab: RightPanelTab;
  /** uid of the code block selected for preview; null = auto-pick latest runnable. */
  previewBlockUid: string | null;
  ws: AgentHubWS | null;

  setActive: (id: string) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  /**
   * Open the Preview tab. Pass `setEntry: true` to also make this block the
   * preview entry (use for explicit picker clicks or App-like files). For
   * child components, default `setEntry: false` keeps the auto-picked entry
   * so the user still sees a working app.
   */
  openPreview: (blockUid: string, opts?: { setEntry?: boolean }) => void;
  sendUserMessage: (conversationId: string, text: string, attachments?: MessageAttachment[]) => void;
  /** Apply plan edits with optimistic concurrency (baseVersion). Server is authoritative. */
  editPlan: (planId: string, edits: PlanEdit[]) => void;
  /** Request AI-suggested deps for a new task; returns a promise. */
  suggestDeps: (planId: string, newGoal: string) => Promise<{ inputs: string[]; reasoning?: string }>;
  /** Trigger a deployment of the given HTML. Status streams in via deploy_status events. */
  triggerDeploy: (input: {
    conversationId: string;
    html: string;
    target: 'vercel' | 'mock';
    projectName?: string;
  }) => void;
  /** Pull persisted messages + plan from server for a conversation. */
  hydrate: (conversationId: string) => Promise<void>;

  // ----- conversation / member / agent management ---------------------
  refreshAgents: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  createConversation: (input: {
    type: 'single' | 'group';
    title: string;
    memberAgentIds: string[];
    memberConfigs?: Array<{
      roleAgentId: string;
      adapterId: string;
      model?: string | null;
      skills?: Array<{ id: string; label: string; prompt: string }>;
      customSkills?: string | null;
    }>;
    groupSystemPrompt?: string | null;
  }) => Promise<ChatConversation>;
  deleteConversation: (id: string) => Promise<void>;
  updateConversation: (
    id: string,
    patch: { title?: string; groupSystemPrompt?: string | null },
  ) => Promise<void>;
  addMember: (conversationId: string, agentId: string) => Promise<void>;
  removeMember: (conversationId: string, agentId: string) => Promise<void>;
  createAgent: (input: {
    name: string;
    adapterId: string;
    systemPrompt: string;
    avatarColor: string;
    model?: string | null;
    apiKey?: string | null;
    baseUrl?: string | null;
  }) => Promise<AgentProfile>;
  updateAgent: (
    id: string,
    patch: Partial<{
      name: string;
      systemPrompt: string;
      avatarColor: string;
      model: string | null;
      apiKey: string | null;
      baseUrl: string | null;
    }>,
  ) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;

  /** Transient banner message (e.g. plan_conflict). null when none. */
  banner: { kind: 'info' | 'warn' | 'error'; text: string } | null;
  dismissBanner: () => void;
  ensureConnected: () => void;
}

/** Pending dep-suggestion request resolvers, keyed by requestId. */
const pendingSuggestions = new Map<
  string,
  { resolve: (v: { inputs: string[]; reasoning?: string }) => void; reject: (e: Error) => void }
>();

/** Server hostname for REST API. WS uses the same host on port 4000. */
function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  const hostname = window.location.hostname.includes(':')
    ? `[${window.location.hostname}]`
    : window.location.hostname;
  return `${window.location.protocol}//${hostname}:4000${path}`;
}

/** Track which conversations have completed initial hydration to avoid refetches. */
const hydratedConvs = new Set<string>();
const hydratingConvs = new Set<string>();

/**
 * Last-resort fallback when an agent appears in a message before the agents
 * list has loaded. Real agent profiles come from the server (DB) via
 * `refreshAgents`. We also retain 'system' as a synthetic profile here so
 * persisted system messages render with a neutral avatar.
 */
const AGENT_PROFILE_FALLBACK: Record<string, { name: string; color: string; adapterId?: string }> = {
  system: { name: 'System', color: '#6b7280' },
  me: { name: '我', color: '#0f766e' },
  orchestrator: { name: '项目流程', color: '#f97316', adapterId: 'orchestrator' },
};

function lookupAgentProfile(
  senderId: string,
  agents: AgentProfile[],
): { name: string; color: string; adapterId?: string } {
  if (isHiddenSystemAgentId(senderId)) {
    return AGENT_PROFILE_FALLBACK[senderId] ?? { name: '系统流程', color: '#9ca3af' };
  }
  const a = agents.find((x) => x.id === senderId);
  if (a) return { name: a.name, color: a.avatarColor, adapterId: a.adapterId };
  // conv-scoped clones aren't in the fetched list — resolve via base role.
  const baseRoleId = baseRoleIdFromConvAgent(senderId);
  if (baseRoleId) {
    const base = agents.find((x) => x.id === baseRoleId);
    if (base) return { name: base.name, color: base.avatarColor, adapterId: base.adapterId };
  }
  return AGENT_PROFILE_FALLBACK[senderId] ?? { name: senderId, color: '#9ca3af' };
}

// Stable seed timestamp — using a fixed string avoids `new Date()` running
// at different moments on server vs client (which broke hydration before).
const SEED_TS = '2026-05-12T10:00:00.000Z';

/**
 * Module-level stable empty array. Zustand calls selectors on every render
 * and React's external-store hook compares references with `Object.is`.
 * Returning `[] ` literally (or `xs ?? []`) creates a new array each call,
 * triggers "getSnapshot should be cached" and infinite re-renders.
 */
export const EMPTY_MESSAGES: readonly ChatMessage[] = Object.freeze([]);
export const EMPTY_DEPLOYMENTS: readonly Deployment[] = Object.freeze([]);

/**
 * Map a ConversationSummary from the server into our store shape. Picks a
 * sensible targetAgentId for single chats (the first visible member).
 */
function fromServerConv(c: {
  id: string;
  type: 'single' | 'group';
  title: string;
  groupSystemPrompt: string | null;
  members: Array<{
    agentId: string;
    name: string;
    adapterId: string;
    avatarColor: string;
    role: 'admin' | 'member' | 'muted';
  }>;
}): ChatConversation {
  const targetAgentId =
    c.type === 'single'
      ? c.members.find((m) => !isHiddenSystemAgentId(m.agentId))?.agentId
      : undefined;
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    groupSystemPrompt: c.groupSystemPrompt,
    members: c.members,
    targetAgentId,
  };
}

function inferMentions(conv: ChatConversation | undefined, text: string): string[] {
  if (!conv) return ['deepseek-v4-flash'];

  const memberIds = new Set(conv.members.map((m) => m.agentId));
  const explicit = new Set<string>();
  for (const m of text.matchAll(/@([\w-]+)/g)) {
    const id = m[1];
    if (id && memberIds.has(id) && !isHiddenSystemAgentId(id)) explicit.add(id);
  }
  if (explicit.size > 0) return [...explicit];

  if (conv.type !== 'group') {
    const fallbackMember = conv.members.find((m) => !isHiddenSystemAgentId(m.agentId)) ?? conv.members[0];
    const defaultSingleAgent =
      conv.targetAgentId && !isHiddenSystemAgentId(conv.targetAgentId)
        ? conv.targetAgentId
        : fallbackMember?.agentId;
    return [defaultSingleAgent ?? 'deepseek-v4-flash'];
  }

  const normalized = text.toLowerCase();
  const has = (patterns: RegExp[]) => patterns.some((re) => re.test(normalized));
  const pick = (ids: string[], namePattern?: RegExp): string | undefined => {
    for (const id of ids) {
      if (memberIds.has(id) && !isHiddenSystemAgentId(id)) return id;
    }
    if (namePattern) {
      const member = conv.members.find((m) =>
        !isHiddenSystemAgentId(m.agentId) && namePattern.test(`${m.name} ${m.agentId} ${m.adapterId}`),
      );
      return member?.agentId;
    }
    return undefined;
  };

  // Only hand off to the project planner when it's clearly a *whole-project*
  // ask. Previously a single "实现登录接口" hijacked the route because any one
  // of three loose groups matched. Now we require either:
  //   (a) an action verb co-occurring with a project-scope noun
  //       ("做一个待办应用"、"搭建一个电商系统"), or
  //   (b) an explicit planning / breakdown request ("帮我拆解一下任务").
  // Single-component requests ("写个登录接口") fall through to role routing.
  const actionVerb =
    /做一个|做个|搭一个|搭个|写一个|创建|生成|开发|实现|搭建|构建|build|create|implement|make/;
  const projectScope =
    /项目|应用|app|网站|网页|系统|平台|产品|端到端|全栈|full[ -]?stack|project|website|dashboard|platform/;
  const planningAsk =
    /拆解|拆分|任务拆|帮我规划|做个规划|项目计划|计划任务|分工|排期|roadmap|break ?down|plan the/;
  const projectIntent =
    (actionVerb.test(normalized) && projectScope.test(normalized)) ||
    planningAsk.test(normalized);
  if (projectIntent) return [PROJECT_PLANNER_MENTION];

  const roleRoutes: Array<{ patterns: RegExp[]; ids: string[]; name?: RegExp }> = [
    {
      patterns: [/前端|界面|ui|ux|页面|组件|样式|css|react|next|动画|preview/],
      ids: ['frontend-engineer'],
      name: /前端|frontend|ui/i,
    },
    {
      patterns: [/后端|接口|api|数据库|鉴权|登录|服务端|server|backend|db|auth/],
      ids: ['backend-engineer'],
      name: /后端|backend|server/i,
    },
    {
      patterns: [/测试|验证|报错|失败|bug|修复|typecheck|compile|build error|不能运行/],
      ids: ['qa-tester', 'code-reviewer'],
      name: /测试|qa|review/i,
    },
    {
      patterns: [/review|审查|代码质量|风险|安全|边界|隐私|漏洞|critic/],
      ids: ['risk-critic', 'code-reviewer'],
      name: /风险|review|critic|审查/i,
    },
    {
      patterns: [/部署|环境|terminal|命令|脚本|docker|vercel|env|ci/],
      ids: ['env-engineer'],
      name: /环境|devops|部署/i,
    },
    {
      patterns: [/产品|需求|用户|体验|文案|验收|范围|prd/],
      ids: ['product-analyst', 'senior-user'],
      name: /产品|用户|analyst|user/i,
    },
    {
      patterns: [/架构|设计|方案|技术选型|模块|数据流|architecture/],
      ids: ['solution-architect'],
      name: /架构|architect/i,
    },
  ];

  for (const route of roleRoutes) {
    if (!has(route.patterns)) continue;
    const id = pick(route.ids, route.name);
    if (id) return [id];
  }

  const architect = pick(['solution-architect'], /架构|architect/i);
  if (architect) return [architect];
  const firstVisible = conv.members.find((m) => !isHiddenSystemAgentId(m.agentId));
  return [firstVisible?.agentId ?? 'deepseek-v4-flash'];
}

export const useConversationStore = create<State>((set, get) => ({
  conversations: [],
  agents: [],
  activeId: null,
  plansByConv: {},
  deploymentsByConv: {},
  rightPanelTab: 'workspace',
  previewBlockUid: null,
  banner: null,
  ws: null,
  // Empty by default — `hydrate(id)` pulls the persisted history from server.
  messagesByConv: {},

  setActive: (id) => {
    set({ activeId: id });
    void get().hydrate(id);
  },

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  openPreview: (blockUid, opts) =>
    set({
      rightPanelTab: 'preview',
      ...(opts?.setEntry ? { previewBlockUid: blockUid } : {}),
    }),

  editPlan: (planId, edits) => {
    const plan = Object.values(get().plansByConv).find((p) => p.id === planId);
    if (!plan) return;
    get().ensureConnected();
    get().ws!.send({
      op: 'edit_plan',
      planId,
      edits,
      baseVersion: plan.version,
    });
  },

  suggestDeps: (planId, newGoal) => {
    get().ensureConnected();
    const requestId = 'sugg-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      pendingSuggestions.set(requestId, { resolve, reject });
      // Safety timeout — if server never replies, don't hang the UI.
      setTimeout(() => {
        if (pendingSuggestions.has(requestId)) {
          pendingSuggestions.delete(requestId);
          reject(new Error('suggestion timeout'));
        }
      }, 30_000);
      get().ws!.send({ op: 'suggest_deps', planId, requestId, newGoal });
    });
  },

  triggerDeploy: (input) => {
    get().ensureConnected();
    get().ws!.send({
      op: 'deploy',
      conversationId: input.conversationId,
      target: input.target,
      html: input.html,
      ...(input.projectName ? { projectName: input.projectName } : {}),
    });
  },

  hydrate: async (id) => {
    if (hydratedConvs.has(id) || hydratingConvs.has(id)) return;
    hydratingConvs.add(id);
    try {
      const res = await fetch(apiUrl(`/api/conversations/${id}/state`));
      if (!res.ok) throw new Error(`hydrate ${res.status}`);
      const data = (await res.json()) as {
        conversationId: string;
        messages: Array<{
          id: string;
          senderType: 'user' | 'agent' | 'system';
          senderId: string;
          text: string;
          attachments?: MessageAttachment[];
          createdAt: string;
        }>;
        plan: Plan | null;
      };
      const agents = get().agents;
      const msgs: ChatMessage[] = data.messages.map((m) => {
        const profile =
          m.senderType === 'user'
            ? { name: '我', color: '#0f766e', adapterId: undefined as string | undefined }
            : lookupAgentProfile(m.senderId, agents);
        return {
          id: m.id,
          conversationId: id,
          senderType: m.senderType,
          senderName: profile.name,
          adapterId: profile.adapterId,
          avatarColor: profile.color,
          text: m.text,
          attachments: m.attachments,
          createdAt: m.createdAt,
        };
      });
      set((s) => ({
        messagesByConv: { ...s.messagesByConv, [id]: msgs },
        ...(data.plan ? { plansByConv: { ...s.plansByConv, [id]: data.plan } } : {}),
      }));
      hydratedConvs.add(id);
    } catch (e) {
      console.warn('[hydrate]', id, e);
    } finally {
      hydratingConvs.delete(id);
    }
  },

  dismissBanner: () => set({ banner: null }),

  ensureConnected: () => {
    if (get().ws) return;
    const hostname =
      typeof window !== 'undefined' && window.location.hostname.includes(':')
        ? `[${window.location.hostname}]`
        : typeof window !== 'undefined'
          ? window.location.hostname
          : 'localhost';
    const wsProtocol =
      typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url =
      typeof window !== 'undefined'
        ? `${wsProtocol}//${hostname}:4000/ws`
        : 'ws://localhost:4000/ws';
    const ws = new AgentHubWS(url);
    ws.subscribe((ev) => handleServerEvent(ev, set, get));
    ws.connect();
    set({ ws });
  },

  sendUserMessage: (conversationId, text, attachments) => {
    get().ensureConnected();
    const conv = get().conversations.find((c) => c.id === conversationId);
    const safeAttachments = attachments?.length ? attachments : undefined;
    const userMsg: ChatMessage = {
      id: 'u' + Date.now(),
      conversationId,
      senderType: 'user',
      senderName: '我',
      avatarColor: '#0f766e',
      text,
      attachments: safeAttachments,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [conversationId]: [...(s.messagesByConv[conversationId] ?? []), userMsg],
      },
    }));
    const mentions = inferMentions(conv, text);
    get().ws!.send({
      op: 'user_msg',
      conversationId,
      content: { kind: 'text', text, ...(safeAttachments ? { attachments: safeAttachments } : {}) },
      mentions,
    });
  },

  // ----- conversation / member / agent management ---------------------

  refreshAgents: async () => {
    try {
      const r = await fetch(apiUrl('/api/agents'));
      if (!r.ok) throw new Error(`agents ${r.status}`);
      const data = (await r.json()) as AgentProfile[];
      set(() => ({ agents: data }));
    } catch (e) {
      console.warn('[refreshAgents]', e);
    }
  },

  refreshConversations: async () => {
    try {
      const r = await fetch(apiUrl('/api/conversations'));
      if (!r.ok) throw new Error(`conversations ${r.status}`);
      const data = (await r.json()) as Array<Parameters<typeof fromServerConv>[0]>;
      const convs = data.map(fromServerConv);
      set((s) => ({
        conversations: convs,
        // Pick first conv as active if none yet.
        activeId: s.activeId ?? convs[0]?.id ?? null,
      }));
      const act = get().activeId;
      if (act) void get().hydrate(act);
    } catch (e) {
      console.warn('[refreshConversations]', e);
    }
  },

  createConversation: async (input) => {
    const r = await fetch(apiUrl('/api/conversations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`create conv ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as Parameters<typeof fromServerConv>[0];
    const conv = fromServerConv(data);
    set((s) => ({
      conversations: [conv, ...s.conversations],
      activeId: conv.id,
    }));
    hydratedConvs.delete(conv.id);
    void get().hydrate(conv.id);
    return conv;
  },

  deleteConversation: async (id) => {
    const r = await fetch(apiUrl(`/api/conversations/${id}`), { method: 'DELETE' });
    if (!r.ok && r.status !== 204) throw new Error(`delete conv ${r.status}`);
    set((s) => {
      const next = s.conversations.filter((c) => c.id !== id);
      return {
        conversations: next,
        activeId: s.activeId === id ? next[0]?.id ?? null : s.activeId,
        agents: s.agents.filter((a) => !a.id.startsWith(`conv-agent-${id}-`)),
      };
    });
  },

  updateConversation: async (id, patch) => {
    const r = await fetch(apiUrl(`/api/conversations/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`update conv ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as Parameters<typeof fromServerConv>[0];
    const updated = fromServerConv(data);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }));
  },

  addMember: async (conversationId, agentId) => {
    const r = await fetch(apiUrl(`/api/conversations/${conversationId}/members`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    if (!r.ok) throw new Error(`add member ${r.status}`);
    const data = (await r.json()) as Parameters<typeof fromServerConv>[0];
    const updated = fromServerConv(data);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? updated : c)),
    }));
  },

  removeMember: async (conversationId, agentId) => {
    const r = await fetch(
      apiUrl(`/api/conversations/${conversationId}/members/${agentId}`),
      { method: 'DELETE' },
    );
    if (!r.ok && r.status !== 204) throw new Error(`remove member ${r.status}`);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, members: c.members.filter((m) => m.agentId !== agentId) }
          : c,
      ),
    }));
  },

  createAgent: async (input) => {
    const r = await fetch(apiUrl('/api/agents'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`create agent ${r.status}: ${await r.text()}`);
    const a = (await r.json()) as AgentProfile;
    set((s) => ({ agents: [a, ...s.agents] }));
    return a;
  },

  updateAgent: async (id, patch) => {
    const r = await fetch(apiUrl(`/api/agents/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`update agent ${r.status}`);
    const a = (await r.json()) as AgentProfile;
    set((s) => ({ agents: s.agents.map((x) => (x.id === id ? a : x)) }));
  },

  deleteAgent: async (id) => {
    const r = await fetch(apiUrl(`/api/agents/${id}`), { method: 'DELETE' });
    if (!r.ok && r.status !== 204) throw new Error(`delete agent ${r.status}`);
    set((s) => ({ agents: s.agents.filter((x) => x.id !== id) }));
  },
}));

/**
 * Token-batching layer. Streaming tokens arrive 1-by-1 (every ~20-40ms);
 * applying each as a separate setState causes the WHOLE message list to
 * re-render, and the *streaming* message re-parses its Markdown / Prism on
 * every token. We accumulate deltas in a Map and flush at most once per
 * ~33ms (≈ 30fps), which collapses ~5-10 tokens into one React update.
 *
 * `msg_done` force-flushes synchronously so the final state is exact.
 */
const pendingTokens = new Map<string, { text: string; thinking: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function bufferTokenDelta(
  msgId: string,
  field: 'text' | 'thinking',
  delta: string,
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
): void {
  const cur = pendingTokens.get(msgId) ?? { text: '', thinking: '' };
  cur[field] += delta;
  pendingTokens.set(msgId, cur);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => flushPendingTokens(set, get), 33);
  }
}

function flushPendingTokens(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingTokens.size === 0) return;
  const pending = new Map(pendingTokens);
  pendingTokens.clear();
  const all = get().messagesByConv;
  const next: Record<string, ChatMessage[]> = { ...all };
  let touched = false;
  for (const [msgId, deltas] of pending) {
    for (const cid in next) {
      const arr = next[cid]!;
      const idx = arr.findIndex((m) => m.id === msgId);
      if (idx < 0) continue;
      next[cid] = arr.map((m, i) =>
        i === idx
          ? {
              ...m,
              text: m.text + deltas.text,
              thinking: (m.thinking ?? '') + deltas.thinking,
            }
          : m,
      );
      touched = true;
      break;
    }
  }
  if (touched) set(() => ({ messagesByConv: next }));
}

function handleServerEvent(
  ev: ServerEvent,
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
) {
  switch (ev.op) {
    case 'msg_started': {
      const senderId = ev.message.senderId;
      const profile = lookupAgentProfile(senderId, get().agents);
      const msg: ChatMessage = {
        id: ev.message.id,
        conversationId: ev.message.conversationId,
        senderType: ev.message.senderType,
        senderName: profile.name,
        adapterId: profile.adapterId,
        avatarColor: profile.color,
        text: '',
        thinking: '',
        streaming: true,
        createdAt: ev.message.createdAt,
      };
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [msg.conversationId]: [...(s.messagesByConv[msg.conversationId] ?? []), msg],
        },
      }));
      return;
    }
    case 'msg_token':
      bufferTokenDelta(ev.msgId, 'text', ev.delta, set, get);
      return;
    case 'msg_thinking':
      bufferTokenDelta(ev.msgId, 'thinking', ev.delta, set, get);
      return;
    case 'msg_done':
      // Drain any buffered tokens first so the final state is exact.
      flushPendingTokens(set, get);
      patchMsg(set, get, ev.msgId, () => ({ streaming: false }));
      return;
    case 'msg_error':
      patchMsg(set, get, ev.msgId, (m) => ({
        streaming: false,
        text: (m.text || '') + `\n\n[error: ${ev.error.code} — ${ev.error.message}]`,
      }));
      return;
    case 'plan_update': {
      const prev = get().plansByConv[ev.plan.conversationId];
      set((s) => ({
        plansByConv: { ...s.plansByConv, [ev.plan.conversationId]: ev.plan },
        // First plan_update for this conversation: auto-pop the Plan tab.
        rightPanelTab:
          !prev && get().activeId === ev.plan.conversationId ? 'plan' : s.rightPanelTab,
      }));
      return;
    }
    case 'plan_conflict':
      set(() => ({
        banner: {
          kind: 'warn',
          text: `Plan 版本冲突（你的 v${ev.clientVersion} / 服务端 v${ev.serverVersion}）。已用最新版本刷新，请重试你的编辑。`,
        },
      }));
      return;
    case 'dep_suggestion': {
      const p = pendingSuggestions.get(ev.requestId);
      if (p) {
        pendingSuggestions.delete(ev.requestId);
        p.resolve({ inputs: ev.suggestedInputs, reasoning: ev.reasoning });
      }
      return;
    }
    case 'dep_suggestion_error': {
      const p = pendingSuggestions.get(ev.requestId);
      if (p) {
        pendingSuggestions.delete(ev.requestId);
        p.reject(new Error(ev.message));
      }
      return;
    }
    case 'deploy_status': {
      const convId = ev.conversationId;
      const dep: Deployment = {
        deploymentId: ev.deploymentId,
        conversationId: convId,
        target: ev.target,
        status: ev.status,
        url: ev.url,
        errorMessage: ev.errorMessage,
        createdAt: ev.createdAt,
      };
      const prev = get().deploymentsByConv[convId] ?? [];
      const existing = prev.findIndex((d) => d.deploymentId === ev.deploymentId);
      const next = existing >= 0 ? prev.map((d, i) => (i === existing ? dep : d)) : [dep, ...prev];
      set((s) => ({
        deploymentsByConv: { ...s.deploymentsByConv, [convId]: next },
        rightPanelTab:
          existing < 0 && get().activeId === convId ? 'deploy' : s.rightPanelTab,
      }));
      return;
    }
  }
}

function patchMsg(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
  msgId: string,
  patch: (m: ChatMessage) => Partial<ChatMessage>,
) {
  const all = get().messagesByConv;
  let foundConv: string | null = null;
  for (const [cid, msgs] of Object.entries(all)) {
    if (msgs.some((m) => m.id === msgId)) {
      foundConv = cid;
      break;
    }
  }
  if (!foundConv) return;
  set((s) => ({
    messagesByConv: {
      ...s.messagesByConv,
      [foundConv!]: s.messagesByConv[foundConv!]!.map((m) =>
        m.id === msgId ? { ...m, ...patch(m) } : m,
      ),
    },
  }));
}
