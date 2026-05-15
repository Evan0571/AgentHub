'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquare, Sparkles, Users, X } from 'lucide-react';
import clsx from 'clsx';
import { isHiddenSystemAgentId, useConversationStore } from '@/lib/store';
import { prettifyApiError } from '@/lib/api-errors';
import { AgentAvatar } from '../AgentAvatar';

/** A reasonable default for a new group — user can clear / rewrite. */
const DEFAULT_GROUP_RULES = `- 全员使用中文回复，结论先行、简洁、避免空话
- 代码块标注语言 + path=相对路径，多文件项目入口命名为 App.tsx 或 main.tsx
- 修改已有文件优先输出 unified diff（语言标 \`diff\`），不要重发整文件
- 多 Agent 协作时只产出自己负责的部分，不替别人写、不做横向对比
- 完成后用一句话总结改动`;

const PROJECT_TEAM_IDS = [
  'product-analyst',
  'solution-architect',
  'frontend-engineer',
  'backend-engineer',
  'code-reviewer',
  'env-engineer',
  'qa-tester',
  'senior-user',
  'risk-critic',
];

/**
 * Modal: pick conv type, name it, choose initial members.
 * Submits POST /api/conversations and sets the new conv as active.
 */
export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const agents = useConversationStore((s) => s.agents);
  const createConversation = useConversationStore((s) => s.createConversation);

  const [type, setType] = useState<'single' | 'group'>('group');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupRules, setGroupRules] = useState('');
  const [didAutoSelectTeam, setDidAutoSelectTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Built-in agents come first, then user-created ones.
  const sortedAgents = useMemo(
    () =>
      agents.filter((a) => !isHiddenSystemAgentId(a.id)).sort((a, b) => {
        if (a.isPublic !== b.isPublic) return a.isPublic ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [agents],
  );
  const projectTeamIds = useMemo(
    () => PROJECT_TEAM_IDS.filter((id) => agents.some((a) => a.id === id)),
    [agents],
  );

  useEffect(() => {
    if (type !== 'group' || didAutoSelectTeam || selected.size > 0 || projectTeamIds.length === 0) return;
    setSelected(new Set(projectTeamIds));
    setDidAutoSelectTeam(true);
  }, [didAutoSelectTeam, projectTeamIds, selected.size, type]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (type === 'single' && next.size > 1) {
        // single chat: only one member.
        const arr = [...next];
        return new Set([arr[arr.length - 1]!]);
      }
      return next;
    });
  };

  const canSubmit = title.trim().length > 0 && selected.size > 0 && !busy;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await createConversation({
        type,
        title: title.trim(),
        memberAgentIds: [...selected],
        groupSystemPrompt: type === 'group' && groupRules.trim() ? groupRules.trim() : null,
      });
      onClose();
    } catch (e) {
      setErr(prettifyApiError(e instanceof Error ? e : String(e), '创建失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose} title="新建会话">
      <div className="space-y-3">
        <div className="flex gap-2">
          <TypeBtn
            active={type === 'group'}
            onClick={() => setType('group')}
            icon={<Users className="h-4 w-4" />}
            label="群聊"
            hint="多个 Agent 协作 · @ 路由"
          />
          <TypeBtn
            active={type === 'single'}
            onClick={() => {
              setType('single');
              if (selected.size > 1) setSelected(new Set([[...selected][0]!]));
            }}
            icon={<MessageSquare className="h-4 w-4" />}
            label="单聊"
            hint="只和一个 Agent 对话"
          />
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">名称</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={type === 'group' ? '如：「待办应用工程群」' : '如：「我 + DeepSeek V3」'}
            className="mt-0.5 w-full rounded bg-bg/60 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              成员（已选 {selected.size}）
            </span>
            {type === 'single' ? (
              <span className="text-[10px] text-text-muted/70">单聊只能选 1 个</span>
            ) : (
              <button
                type="button"
                onClick={() => setSelected(new Set(projectTeamIds))}
                disabled={projectTeamIds.length === 0}
                className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40"
              >
                选择标准项目团队
              </button>
            )}
          </div>
          <div className="mt-0.5 max-h-64 space-y-1 overflow-y-auto rounded-md border border-white/5 bg-bg/40 p-1">
            {sortedAgents.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-text-muted">
                还没有 Agent — 关闭后到设置里新建
              </div>
            ) : (
              sortedAgents.map((a) => {
                const checked = selected.has(a.id);
                return (
                  <button
                    type="button"
                    key={a.id}
                    onClick={() => toggle(a.id)}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition',
                      checked ? 'bg-accent/20' : 'hover:bg-white/5',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      readOnly
                      className="pointer-events-none"
                    />
                    <AgentAvatar
                      name={a.name}
                      adapterId={a.adapterId}
                      color={a.avatarColor}
                      size={24}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{a.name}</span>
                      <span className="block truncate text-[10px] text-text-muted">
                        {a.isPublic ? '内置' : '自定义'} · {a.adapterId}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {type === 'group' ? (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                群规则（可选 · 注入到每个成员的 system prompt）
              </span>
              <button
                type="button"
                onClick={() => setGroupRules(DEFAULT_GROUP_RULES)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10"
                title="套用默认协作规则模板"
              >
                <Sparkles className="h-2.5 w-2.5" />
                用默认模板
              </button>
            </div>
            <textarea
              value={groupRules}
              onChange={(e) => setGroupRules(e.target.value)}
              rows={4}
              placeholder='留空 = 不注入 · 点上面的「用默认模板」可一键生成协作规则'
              className="mt-0.5 w-full resize-none rounded bg-bg/60 px-2 py-1.5 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        ) : null}

        {err ? (
          <div className="rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">{err}</div>
        ) : null}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-text-muted hover:bg-white/5 hover:text-text"
        >
          取消
        </button>
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          创建
        </button>
      </div>
    </ModalShell>
  );
}

function TypeBtn({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex flex-1 flex-col items-start gap-0.5 rounded-md border p-2 text-left text-xs transition',
        active
          ? 'border-accent/40 bg-accent/10 text-text'
          : 'border-white/5 bg-bg/60 text-text-muted hover:border-white/10 hover:text-text',
      )}
    >
      <span className="flex items-center gap-1.5 font-medium">
        {icon}
        {label}
      </span>
      <span className="text-[10px] text-text-muted">{hint}</span>
    </button>
  );
}

export function ModalShell({
  onClose,
  title,
  children,
  width = 'w-[480px]',
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={clsx(
          'rounded-lg border border-white/10 bg-bg-soft shadow-2xl',
          width,
          'max-h-[90vh] overflow-y-auto',
        )}
      >
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
