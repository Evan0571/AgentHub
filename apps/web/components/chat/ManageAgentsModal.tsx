'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Eye, EyeOff, KeyRound, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useConversationStore, type AgentProfile } from '@/lib/store';
import { ModalShell } from './NewConversationDialog';
import { prettifyApiError } from '@/lib/api-errors';
import { AgentAvatar } from '../AgentAvatar';

/**
 * Provider catalog. Each entry maps to a server-side adapter; the model list
 * is a UI hint only — the server passes whatever model string we send,
 * provided the underlying SDK accepts it. Keys in `models` are the literal
 * `model` values the provider's API expects.
 */
interface Provider {
  id: string;            // adapterId sent to server (must match adapter.factory.ts switch)
  label: string;
  hint: string;
  /** When true, "Bring your own API key" + baseUrl are required (no env fallback). */
  requiresOwnKey: boolean;
  /** When true, show a baseUrl input. */
  hasBaseUrl: boolean;
  defaultBaseUrl?: string;
  models: Array<{ id: string; label: string; hint?: string }>;
}

const PROVIDERS: Provider[] = [
  {
    id: 'deepseek-v3',
    label: 'DeepSeek',
    hint: '通用 / 推理 — OpenAI 兼容协议',
    requiresOwnKey: false,
    hasBaseUrl: false,
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3', hint: '通用 · 快 · 便宜' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1', hint: '复杂推理 · 思考链' },
    ],
  },
  {
    id: 'codex',
    label: 'OpenAI',
    hint: 'GPT 系列 — 代码 / 推理',
    requiresOwnKey: false,
    hasBaseUrl: false,
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', hint: '旗舰 · 多模态' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', hint: '便宜 · 默认' },
      { id: 'gpt-4.1', label: 'GPT-4.1', hint: '长上下文 · 编码' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', hint: '便宜 · 长上下文' },
      { id: 'o4-mini', label: 'o4-mini', hint: '推理优先' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude 系列 — 工具调用 / 长文',
    requiresOwnKey: false,
    hasBaseUrl: false,
    models: [
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: '旗舰 · 推理' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: '平衡' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: '便宜 · 快' },
    ],
  },
  {
    id: 'doubao',
    label: '豆包 / Doubao',
    hint: '火山方舟 — OpenAI 兼容',
    requiresOwnKey: false,
    hasBaseUrl: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { id: 'doubao-pro-32k', label: 'Doubao Pro 32K' },
      { id: 'doubao-lite-32k', label: 'Doubao Lite 32K' },
    ],
  },
  {
    id: 'openai-compatible',
    label: '自定义 (OpenAI 兼容)',
    hint: 'Ollama / vLLM / OneAPI / Groq / 其他第三方',
    requiresOwnKey: true,
    hasBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'llama3.1:8b', label: 'llama3.1:8b (Ollama)' },
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b (Ollama)' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral (Groq)' },
    ],
  },
  {
    id: 'mock',
    label: 'Mock',
    hint: '本地回放 · 不烧 token',
    requiresOwnKey: false,
    hasBaseUrl: false,
    models: [{ id: '', label: '(默认)' }],
  },
];

function findProvider(adapterId: string): Provider {
  return PROVIDERS.find((p) => p.id === adapterId) ?? PROVIDERS[0]!;
}

const AVATAR_PALETTE = [
  '#6366f1', '#4f46e5', '#7c3aed', '#a855f7', '#ec4899',
  '#ef4444', '#f97316', '#eab308', '#10b981', '#14b8a6',
  '#0ea5e9', '#6b7280',
];

const ROLE_PRESETS: Array<{ id: string; name: string; description: string; systemPrompt: string }> = [
  {
    id: 'architect',
    name: '架构师',
    description: '需求澄清 / 技术选型 / 任务切分',
    systemPrompt: `你是 AgentHub 群聊中的"架构师"。

## 职责
1. 澄清模糊需求（最多 3 个高优先级反问）。
2. 给出方案：技术栈、模块、外部依赖（编号清单）。
3. 切分为 < 2 小时的子任务，标明入参 / 出参 / 验收。
4. 必要时 @ 适合的同事执行；不要自己写代码。

## 风格
- 中文，简洁，避免空话；重要决策给出一句话"为什么"。`,
  },
  {
    id: 'frontend',
    name: '前端工程师',
    description: 'React / Next.js / Tailwind 实现',
    systemPrompt: `你是 AgentHub 群聊中的"前端工程师"。

## 技术栈
- React 19 + Next.js 15 (App Router) + TypeScript
- Tailwind CSS；状态用 Zustand；表单用 react-hook-form + zod

## 工作方式
1. 先读项目结构，避免重复造轮子。
2. 写代码直接输出可运行片段；不写无意义注释 / 多段 JSDoc。
3. 一次聚焦一个目标，避免 drive-by refactor。
4. 完成后用一句话总结，并 @reviewer 进行 review。`,
  },
  {
    id: 'backend',
    name: '后端工程师',
    description: 'NestJS / API / 数据建模',
    systemPrompt: `你是 AgentHub 群聊中的"后端工程师"。

## 技术栈
- NestJS + TypeScript；Drizzle ORM + PostgreSQL
- WebSocket / REST 双通道

## 工作方式
1. 先确定数据模型 + API 边界，再写实现。
2. 输入用 zod 校验；外部错误统一抛 HttpException。
3. 不滥用抽象；保持文件 < 300 行。
4. 完成后给出一行 curl / 请求示例。`,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: '代码 review / 风险点提示',
    systemPrompt: `你是 AgentHub 群聊中的"Code Reviewer"。

## 职责
1. 检查正确性、边界条件、错误处理、安全（注入 / 越权 / 资源泄漏）。
2. 指出可读性 / 命名 / 命名空间问题。
3. 用 [Block] / [Suggest] / [Nit] 三个级别标注；Block 必须修。
4. 不写代码；只指方向。`,
  },
  {
    id: 'devops',
    name: 'DevOps',
    description: 'CI / 部署 / 环境配置',
    systemPrompt: `你是 AgentHub 群聊中的"DevOps"。

## 职责
1. 部署、CI、环境变量、容器化。
2. 给出最小可运行命令 + 失败回滚方案。
3. 不引入额外平台 / 工具，除非有充分理由。`,
  },
  {
    id: 'critic',
    name: 'Critic',
    description: '风险 / 反例 / 边界审视',
    systemPrompt: `你是 AgentHub 群聊中的"Critic"。

## 职责
1. 假设当前方案错误，列举 3 个最有可能崩盘的点。
2. 给出可复现的反例 / 边界用例。
3. 不否定一切；找最致命的问题，按严重度排序。`,
  },
  {
    id: 'free',
    name: '自定义',
    description: '空白 system prompt — 你自己写',
    systemPrompt: '',
  },
];

export function ManageAgentsModal({ onClose }: { onClose: () => void }) {
  const agents = useConversationStore((s) => s.agents);
  const createAgent = useConversationStore((s) => s.createAgent);
  const updateAgent = useConversationStore((s) => s.updateAgent);
  const deleteAgent = useConversationStore((s) => s.deleteAgent);

  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'create' } | { kind: 'edit'; agent: AgentProfile }>(
    { kind: 'list' },
  );

  const sorted = useMemo(
    () =>
      [...agents].sort((a, b) => {
        if (a.isPublic !== b.isPublic) return a.isPublic ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [agents],
  );

  const onDelete = async (a: AgentProfile) => {
    if (a.isPublic) {
      alert('内置 Agent 不能删除');
      return;
    }
    if (!confirm(`确认删除 Agent「${a.name}」？已存在于会话中的成员关系也会被移除。`)) return;
    try {
      await deleteAgent(a.id);
    } catch (e) {
      alert(prettifyApiError(e instanceof Error ? e : String(e), '删除 Agent 失败'));
    }
  };

  return (
    <ModalShell onClose={onClose} title="Agent 设置" width="w-[640px]">
      {mode.kind === 'list' ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-text-muted">
              共 {sorted.length} 个 Agent，{sorted.filter((a) => a.isPublic).length} 个内置
            </div>
            <button
              onClick={() => setMode({ kind: 'create' })}
              className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover"
            >
              <Plus className="h-3 w-3" />
              新建 Agent
            </button>
          </div>

          <ul className="space-y-1 rounded-md border border-white/5 bg-bg/40 p-1">
            {sorted.map((a) => {
              const provider = findProvider(a.adapterId);
              return (
                <li
                  key={a.id}
                  className="group flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-white/5"
                >
                  <AgentAvatar
                    name={a.name}
                    adapterId={a.adapterId}
                    color={a.avatarColor}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate font-medium">
                      {a.name}
                      {a.isPublic ? <Lock className="h-3 w-3 text-text-muted/70" /> : null}
                      {a.hasApiKey ? (
                        <span
                          className="rounded bg-emerald-500/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-emerald-300"
                          title="自带 API Key"
                        >
                          BYOK
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-[10px] text-text-muted">
                      @{a.id} · {provider.label}
                      {a.model ? ` / ${a.model}` : ''}
                      {a.baseUrl ? ` · ${shortUrl(a.baseUrl)}` : ''}
                      {a.systemPrompt
                        ? ` · ${a.systemPrompt.slice(0, 32)}${a.systemPrompt.length > 32 ? '…' : ''}`
                        : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setMode({ kind: 'edit', agent: a })}
                    disabled={a.isPublic}
                    className="rounded p-1 text-text-muted opacity-0 hover:bg-white/5 hover:text-text disabled:cursor-not-allowed disabled:opacity-0 group-hover:opacity-100 disabled:group-hover:opacity-30"
                    title={a.isPublic ? '内置 Agent 不可编辑' : '编辑'}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => void onDelete(a)}
                    disabled={a.isPublic}
                    className="rounded p-1 text-rose-300/70 opacity-0 hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-0 group-hover:opacity-100 disabled:group-hover:opacity-30"
                    title={a.isPublic ? '内置 Agent 不可删除' : '删除'}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : mode.kind === 'create' ? (
        <AgentForm
          mode="create"
          initial={null}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={async (data) => {
            await createAgent(data);
            setMode({ kind: 'list' });
          }}
        />
      ) : (
        <AgentForm
          mode="edit"
          initial={mode.agent}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={async (data) => {
            await updateAgent(mode.agent.id, {
              name: data.name,
              systemPrompt: data.systemPrompt,
              avatarColor: data.avatarColor,
              model: data.model ?? null,
              baseUrl: data.baseUrl ?? null,
              // apiKey: undefined → leave untouched. Caller decides.
              ...(data.apiKey !== undefined ? { apiKey: data.apiKey } : {}),
            });
            setMode({ kind: 'list' });
          }}
        />
      )}
    </ModalShell>
  );
}

interface FormData {
  name: string;
  adapterId: string;
  systemPrompt: string;
  avatarColor: string;
  model: string | null;
  baseUrl: string | null;
  /**
   * undefined → leave the saved key untouched (edit mode);
   * ''        → clear the saved key;
   * '...'     → replace.
   */
  apiKey?: string | null;
}

function AgentForm({
  mode,
  initial,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: AgentProfile | null;
  onCancel: () => void;
  onSubmit: (data: FormData) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [providerId, setProviderId] = useState(initial?.adapterId ?? 'deepseek-v3');
  const provider = findProvider(providerId);

  const [model, setModel] = useState<string>(
    initial?.model ?? provider.models[0]?.id ?? '',
  );
  const [baseUrl, setBaseUrl] = useState<string>(initial?.baseUrl ?? provider.defaultBaseUrl ?? '');
  const [useOwnKey, setUseOwnKey] = useState<boolean>(
    provider.requiresOwnKey || (initial?.hasApiKey ?? false),
  );
  const [apiKey, setApiKey] = useState<string>('');
  const [keyVisible, setKeyVisible] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [avatarColor, setAvatarColor] = useState(initial?.avatarColor ?? AVATAR_PALETTE[0]!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onProviderChange = (next: string) => {
    setProviderId(next);
    const np = findProvider(next);
    // Reset model + baseUrl to the new provider's defaults.
    setModel(np.models[0]?.id ?? '');
    setBaseUrl(np.defaultBaseUrl ?? '');
    if (np.requiresOwnKey) setUseOwnKey(true);
  };

  const applyPreset = (preset: typeof ROLE_PRESETS[number]) => {
    setSystemPrompt(preset.systemPrompt);
    if (!name.trim() || ROLE_PRESETS.some((p) => p.name === name)) {
      setName(preset.name);
    }
  };

  const canSubmit = name.trim().length > 0 && !busy && (!provider.requiresOwnKey || apiKey.length > 0 || initial?.hasApiKey);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const payload: FormData = {
        name: name.trim(),
        adapterId: providerId,
        systemPrompt: systemPrompt.trim(),
        avatarColor,
        model: model || null,
        baseUrl: provider.hasBaseUrl && baseUrl ? baseUrl : null,
      };
      if (useOwnKey) {
        // Only include apiKey when user actually typed one (otherwise leave saved one alone).
        if (apiKey) payload.apiKey = apiKey;
      } else if (mode === 'edit' && initial?.hasApiKey) {
        // User turned BYOK off → clear stored key.
        payload.apiKey = '';
      }
      await onSubmit(payload);
    } catch (e) {
      setErr(prettifyApiError(e instanceof Error ? e : String(e), '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">名称</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：「我的前端工程师」"
          className="mt-0.5 w-full rounded bg-bg/60 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
      </label>

      <div>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">底座 / Provider</span>
        {mode === 'create' ? (
          <div className="mt-0.5 grid grid-cols-2 gap-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onProviderChange(p.id)}
                className={clsx(
                  'rounded border px-2 py-1.5 text-left text-xs transition',
                  providerId === p.id
                    ? 'border-accent/40 bg-accent/10 text-text'
                    : 'border-white/5 bg-bg/60 text-text-muted hover:text-text',
                )}
              >
                <div className="font-medium">{p.label}</div>
                <div className="text-[10px] text-text-muted">{p.hint}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-0.5 rounded bg-bg/40 px-2 py-1.5 text-[11px] text-text-muted">
            <span className="text-text">{provider.label}</span> · {provider.hint}（不可改 — 删了重建即可）
          </div>
        )}
      </div>

      {provider.models.length > 0 ? (
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">模型</span>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {provider.models.map((m) => (
              <button
                key={m.id || 'default'}
                type="button"
                onClick={() => setModel(m.id)}
                className={clsx(
                  'rounded border px-2 py-1 text-[11px] transition',
                  model === m.id
                    ? 'border-accent/40 bg-accent/10 text-text'
                    : 'border-white/5 bg-bg/60 text-text-muted hover:text-text',
                )}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="或手填 model id"
              className="flex-1 rounded bg-bg/60 px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </label>
      ) : null}

      {provider.hasBaseUrl ? (
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Base URL{provider.requiresOwnKey ? ' (必填)' : ' (可选 · 留空走默认)'}
          </span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider.defaultBaseUrl}
            className="mt-0.5 w-full rounded bg-bg/60 px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
      ) : null}

      <div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            <KeyRound className="mb-0.5 mr-1 inline h-3 w-3" />
            API Key
            {provider.requiresOwnKey ? ' (必填)' : ''}
          </span>
          {!provider.requiresOwnKey ? (
            <label className="flex items-center gap-1 text-[10px] text-text-muted">
              <input
                type="checkbox"
                checked={useOwnKey}
                onChange={(e) => setUseOwnKey(e.target.checked)}
                className="h-3 w-3"
              />
              <span>用我自己的 Key（否则用 server .env 默认）</span>
            </label>
          ) : null}
        </div>
        {useOwnKey ? (
          <div className="mt-0.5 flex gap-1">
            <input
              type={keyVisible ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                initial?.hasApiKey ? '已存有 Key — 留空保持原 key，输入新值则覆盖' : 'sk-...'
              }
              className="flex-1 rounded bg-bg/60 px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-accent"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setKeyVisible(!keyVisible)}
              className="rounded bg-bg/60 px-2 text-text-muted hover:text-text"
              title={keyVisible ? '隐藏' : '显示'}
            >
              {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        ) : null}
        {useOwnKey ? (
          <div className="mt-1 text-[10px] text-text-muted/70">
            Key 用 AES-256-GCM 加密后入库；服务端通过 AGENTHUB_SECRET 解密，前端永远拿不到原文。
          </div>
        ) : null}
      </div>

      <div>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">头像色</span>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {AVATAR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setAvatarColor(c)}
              className={clsx(
                'h-6 w-6 rounded transition',
                avatarColor === c ? 'ring-2 ring-white' : 'opacity-70 hover:opacity-100',
              )}
              style={{ background: c }}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      <div>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          角色预设（点击套用，再自由编辑）
        </span>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {ROLE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded border border-white/5 bg-bg/60 px-2 py-1 text-[11px] text-text-muted hover:border-accent/30 hover:text-text"
              title={p.description}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">System Prompt</span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder="可以留空 — 也可以点上面的预设；这段会和群规则一起注入给底座模型。"
          className="mt-0.5 w-full resize-none rounded bg-bg/60 px-2 py-1.5 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-accent"
        />
      </label>

      {err ? (
        <div className="rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">{err}</div>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-text-muted hover:bg-white/5 hover:text-text"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {mode === 'create' ? '创建' : '保存'}
        </button>
      </div>
    </div>
  );
}

function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.host + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return u;
  }
}
