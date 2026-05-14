'use client';

import { create } from 'zustand';
import type { ServerEvent, Plan, PlanEdit } from '@agenthub/shared-types';
import { AgentHubWS } from './ws-client';

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  avatarColor?: string;
  text: string;
  thinking?: string;
  streaming?: boolean;
  createdAt: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  type: 'single' | 'group';
  /** For single chats: which agent to invoke by default. */
  targetAgentId?: string;
  members: { id: string; name: string; color: string }[];
  preview: string;
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
  sendUserMessage: (conversationId: string, text: string) => void;
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
  return `http://${window.location.hostname}:4000${path}`;
}

/** Track which conversations have completed initial hydration to avoid refetches. */
const hydratedConvs = new Set<string>();
const hydratingConvs = new Set<string>();

const AGENT_PROFILE: Record<
  string,
  { name: string; color: string }
> = {
  'deepseek-v3': { name: 'DeepSeek V3', color: '#4f46e5' },
  'deepseek-r1': { name: 'DeepSeek R1', color: '#7c3aed' },
  'claude-code': { name: 'Claude Code', color: '#d97706' },
  codex: { name: 'Codex (GPT-4o)', color: '#10b981' },
  doubao: { name: '豆包', color: '#ef4444' },
  mock: { name: 'Mock', color: '#6b7280' },
  orchestrator: { name: 'Orchestrator', color: '#f97316' },
};

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

const seedConvs: ChatConversation[] = [
  {
    id: 'c1',
    title: '我 + DeepSeek V3',
    type: 'single',
    targetAgentId: 'deepseek-v3',
    members: [{ id: 'deepseek-v3', name: 'DeepSeek V3', color: '#4f46e5' }],
    preview: '通用对话 / 写代码（快）',
  },
  {
    id: 'c3',
    title: '我 + DeepSeek R1（带思考链）',
    type: 'single',
    targetAgentId: 'deepseek-r1',
    members: [{ id: 'deepseek-r1', name: 'DeepSeek R1', color: '#7c3aed' }],
    preview: '复杂推理 / 规划（带思考过程）',
  },
  {
    id: 'c2',
    title: '待办应用工程群',
    type: 'group',
    members: [
      { id: 'orchestrator', name: 'Orchestrator', color: '#f97316' },
      { id: 'deepseek-r1', name: 'DeepSeek R1', color: '#7c3aed' },
      { id: 'deepseek-v3', name: 'DeepSeek V3', color: '#4f46e5' },
      { id: 'codex', name: 'Codex (GPT-4o)', color: '#10b981' },
    ],
    preview: '@orchestrator 一句话需求 → Plan → 多 Agent 并行…',
  },
];

export const useConversationStore = create<State>((set, get) => ({
  conversations: seedConvs,
  activeId: 'c1',
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
          createdAt: string;
        }>;
        plan: Plan | null;
      };
      const msgs: ChatMessage[] = data.messages.map((m) => {
        const profile =
          m.senderType === 'user'
            ? { name: '我', color: '#6366f1' }
            : AGENT_PROFILE[m.senderId] ?? { name: m.senderId, color: '#9ca3af' };
        return {
          id: m.id,
          conversationId: id,
          senderType: m.senderType,
          senderName: profile.name,
          avatarColor: profile.color,
          text: m.text,
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
    const url =
      typeof window !== 'undefined'
        ? `ws://${window.location.hostname}:4000/ws`
        : 'ws://localhost:4000/ws';
    const ws = new AgentHubWS(url);
    ws.subscribe((ev) => handleServerEvent(ev, set, get));
    ws.connect();
    set({ ws });
  },

  sendUserMessage: (conversationId, text) => {
    get().ensureConnected();
    const conv = get().conversations.find((c) => c.id === conversationId);
    const userMsg: ChatMessage = {
      id: 'u' + Date.now(),
      conversationId,
      senderType: 'user',
      senderName: '我',
      avatarColor: '#6366f1',
      text,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [conversationId]: [...(s.messagesByConv[conversationId] ?? []), userMsg],
      },
    }));
    // Pull @agent-id mentions from the text and intersect with conversation members.
    // Fall back to the conversation's default target (single-chat) or first member.
    const memberIds = new Set(conv?.members.map((m) => m.id) ?? []);
    const found = new Set<string>();
    for (const m of text.matchAll(/@([\w-]+)/g)) {
      const id = m[1];
      if (id && memberIds.has(id)) found.add(id);
    }
    const mentions =
      found.size > 0
        ? [...found]
        : [conv?.targetAgentId ?? conv?.members[0]?.id ?? 'deepseek-v3'];
    get().ws!.send({
      op: 'user_msg',
      conversationId,
      content: { kind: 'text', text },
      mentions,
    });
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
      const profile = AGENT_PROFILE[senderId] ?? { name: senderId, color: '#9ca3af' };
      const msg: ChatMessage = {
        id: ev.message.id,
        conversationId: ev.message.conversationId,
        senderType: ev.message.senderType,
        senderName: profile.name,
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
