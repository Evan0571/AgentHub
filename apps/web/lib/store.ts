'use client';

import { create } from 'zustand';
import type { ServerEvent, Plan } from '@agenthub/shared-types';
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

interface State {
  conversations: ChatConversation[];
  activeId: string | null;
  messagesByConv: Record<string, ChatMessage[]>;
  plansByConv: Record<string, Plan>;
  rightPanelTab: RightPanelTab;
  ws: AgentHubWS | null;

  setActive: (id: string) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  sendUserMessage: (conversationId: string, text: string) => void;
  ensureConnected: () => void;
}

const AGENT_PROFILE: Record<
  string,
  { name: string; color: string }
> = {
  'deepseek-v3': { name: 'DeepSeek V3', color: '#4f46e5' },
  'deepseek-r1': { name: 'DeepSeek R1', color: '#7c3aed' },
  'claude-code': { name: 'Claude Code', color: '#d97706' },
  codex: { name: 'Codex', color: '#10b981' },
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
    ],
    preview: '@orchestrator 一句话需求 → Plan → 多 Agent 并行…',
  },
];

export const useConversationStore = create<State>((set, get) => ({
  conversations: seedConvs,
  activeId: 'c1',
  plansByConv: {},
  rightPanelTab: 'workspace',
  ws: null,
  messagesByConv: {
    c1: [
      {
        id: 'sys1',
        conversationId: 'c1',
        senderType: 'system',
        senderName: 'System',
        avatarColor: '#6b7280',
        text: '👋 这是和 DeepSeek **V3** 的单聊。响应快、便宜，适合通用对话和写代码。',
        createdAt: SEED_TS,
      },
    ],
    c3: [
      {
        id: 'sys3',
        conversationId: 'c3',
        senderType: 'system',
        senderName: 'System',
        avatarColor: '#6b7280',
        text: '🧠 这是和 DeepSeek **R1** 的单聊。会先展示「思考过程」再给出答案，适合复杂推理、规划、算法题。',
        createdAt: SEED_TS,
      },
    ],
    c2: [
      {
        id: 'sys2',
        conversationId: 'c2',
        senderType: 'system',
        senderName: 'System',
        avatarColor: '#6b7280',
        text: '🛠️ 这是工程群（demo 占位）。一旦 Orchestrator 接通，一句话需求会被自动拆成 DAG 由多个 Agent 协作完成。',
        createdAt: SEED_TS,
      },
    ],
  },

  setActive: (id) => set({ activeId: id }),

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

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
      patchMsg(set, get, ev.msgId, (m) => ({ text: m.text + ev.delta }));
      return;
    case 'msg_thinking':
      patchMsg(set, get, ev.msgId, (m) => ({ thinking: (m.thinking ?? '') + ev.delta }));
      return;
    case 'msg_done':
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
