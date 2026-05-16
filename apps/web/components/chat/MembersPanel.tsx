'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2, UserMinus, X } from 'lucide-react';
import clsx from 'clsx';
import { isConversationScopedAgentId, isHiddenSystemAgentId, useConversationStore, type ChatConversation } from '@/lib/store';
import { ModalShell } from './NewConversationDialog';
import { prettifyApiError } from '@/lib/api-errors';
import { AgentAvatar } from '../AgentAvatar';

/**
 * WeChat-style group info panel: shown when user clicks chat header.
 * Single-chat view shows fewer controls (no rename / no rules / no kick).
 */
export function MembersPanel({
  conversation,
  onClose,
}: {
  conversation: ChatConversation;
  onClose: () => void;
}) {
  const agents = useConversationStore((s) => s.agents);
  const addMember = useConversationStore((s) => s.addMember);
  const removeMember = useConversationStore((s) => s.removeMember);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);

  const [invitingOpen, setInvitingOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(conversation.title);
  const [rulesDraft, setRulesDraft] = useState(conversation.groupSystemPrompt ?? '');
  const [rulesDirty, setRulesDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'title' | 'rules' | 'delete'>(null);

  // Keep drafts in sync when the panel re-opens for a different conv or the
  // underlying state changes (e.g. after a successful save).
  useEffect(() => {
    setTitleDraft(conversation.title);
    setRulesDraft(conversation.groupSystemPrompt ?? '');
    setRulesDirty(false);
  }, [conversation.id, conversation.title, conversation.groupSystemPrompt]);

  const memberIds = useMemo(
    () => new Set(conversation.members.map((m) => m.agentId)),
    [conversation.members],
  );
  const visibleMembers = useMemo(
    () => conversation.members.filter((m) => !isHiddenSystemAgentId(m.agentId)),
    [conversation.members],
  );
  const candidates = useMemo(
    () => agents.filter((a) => !isHiddenSystemAgentId(a.id) && !isConversationScopedAgentId(a.id) && !memberIds.has(a.id)),
    [agents, memberIds],
  );

  const isGroup = conversation.type === 'group';

  const onAdd = async (agentId: string) => {
    try {
      await addMember(conversation.id, agentId);
    } catch (e) {
      alert(prettifyApiError(e instanceof Error ? e : String(e), '操作失败'));
    }
  };

  const onKick = async (agentId: string, name: string) => {
    if (!isGroup) {
      alert('单聊不能踢出唯一成员，请直接删除会话');
      return;
    }
    if (!confirm(`确认踢出 ${name}？`)) return;
    try {
      await removeMember(conversation.id, agentId);
    } catch (e) {
      alert(prettifyApiError(e instanceof Error ? e : String(e), '操作失败'));
    }
  };

  const onSaveTitle = async () => {
    const next = titleDraft.trim();
    if (!next || next === conversation.title) {
      setEditingTitle(false);
      setTitleDraft(conversation.title);
      return;
    }
    setBusy('title');
    try {
      await updateConversation(conversation.id, { title: next });
      setEditingTitle(false);
    } catch (e) {
      alert(prettifyApiError(e instanceof Error ? e : String(e), '操作失败'));
    } finally {
      setBusy(null);
    }
  };

  const onSaveRules = async () => {
    setBusy('rules');
    try {
      await updateConversation(conversation.id, {
        groupSystemPrompt: rulesDraft.trim() ? rulesDraft.trim() : null,
      });
      setRulesDirty(false);
    } catch (e) {
      alert(prettifyApiError(e instanceof Error ? e : String(e), '操作失败'));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    if (!confirm(`确认删除「${conversation.title}」？历史消息将一并清除。`)) return;
    setBusy('delete');
    try {
      await deleteConversation(conversation.id);
      onClose();
    } catch (e) {
      alert((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <ModalShell onClose={onClose} title={isGroup ? '群信息' : '聊天信息'} width="w-[480px]">
      <div className="space-y-3.5">
        {/* ----- title ----- */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">名称</div>
          {editingTitle ? (
            <div className="mt-0.5 flex gap-1">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSaveTitle();
                  if (e.key === 'Escape') {
                    setEditingTitle(false);
                    setTitleDraft(conversation.title);
                  }
                }}
                className="flex-1 rounded bg-bg/60 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={() => void onSaveTitle()}
                disabled={busy === 'title'}
                className="rounded bg-accent px-2 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {busy === 'title' ? <Loader2 className="h-3 w-3 animate-spin" /> : '保存'}
              </button>
              <button
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(conversation.title);
                }}
                className="rounded bg-bg/60 px-2 text-xs text-text-muted hover:text-text"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-white/5"
            >
              <span className="flex-1 truncate font-medium">{conversation.title}</span>
              <Pencil className="h-3 w-3 text-text-muted opacity-50" />
            </button>
          )}
        </div>

        {/* ----- members ----- */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              成员（{visibleMembers.length}）
            </span>
            <span className="text-[10px] text-text-muted/70">
              {isGroup ? '群聊 · @ 路由' : '单聊'}
            </span>
          </div>
          <ul className="mt-0.5 space-y-0.5 rounded-md border border-white/5 bg-bg/40 p-1">
            {visibleMembers.map((m) => (
              <li
                key={m.agentId}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5"
              >
                <AgentAvatar
                  name={m.name}
                  adapterId={m.adapterId}
                  color={m.avatarColor}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{m.name}</div>
                  <div className="truncate text-[10px] text-text-muted">
                    @{m.agentId} · {m.adapterId}
                  </div>
                </div>
                {isGroup ? (
                  <button
                    onClick={() => void onKick(m.agentId, m.name)}
                    className="rounded p-1 text-rose-300/70 hover:bg-rose-500/10 hover:text-rose-300"
                    title="踢出"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {isGroup ? (
            invitingOpen ? (
              <div className="mt-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-emerald-300">
                    邀请 Agent
                  </span>
                  <button
                    onClick={() => setInvitingOpen(false)}
                    className="rounded p-0.5 text-text-muted hover:text-text"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {candidates.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-text-muted">
                    所有可用 Agent 都已在群里 — 先去 ⚙️ 新建一个
                  </div>
                ) : (
                  <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                    {candidates.map((a) => (
                      <li key={a.id}>
                        <button
                          onClick={async () => {
                            await onAdd(a.id);
                            setInvitingOpen(false);
                          }}
                          className={clsx(
                            'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                            'hover:bg-white/10',
                          )}
                        >
                          <AgentAvatar
                            name={a.name}
                            adapterId={a.adapterId}
                            color={a.avatarColor}
                            size={20}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{a.name}</span>
                            <span className="block truncate text-[10px] text-text-muted">
                              {a.isPublic ? '内置' : '自定义'} · {a.adapterId}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <button
                onClick={() => setInvitingOpen(true)}
                className="mt-1 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/10 py-1.5 text-xs text-text-muted hover:border-accent/40 hover:bg-white/5 hover:text-text"
              >
                <Plus className="h-3 w-3" />
                邀请 Agent
              </button>
            )
          ) : null}
        </div>

        {/* ----- group rules (group only) ----- */}
        {isGroup ? (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                群规则（会注入到每个 Agent 的 system prompt）
              </span>
              {rulesDirty ? (
                <button
                  onClick={() => void onSaveRules()}
                  disabled={busy === 'rules'}
                  className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[10px] text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  {busy === 'rules' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
                  保存
                </button>
              ) : null}
            </div>
            <textarea
              value={rulesDraft}
              onChange={(e) => {
                setRulesDraft(e.target.value);
                setRulesDirty(e.target.value !== (conversation.groupSystemPrompt ?? ''));
              }}
              rows={3}
              placeholder='如「全员中文回复，代码风格遵循 ESLint 默认」'
              className="mt-0.5 w-full resize-none rounded bg-bg/60 px-2 py-1.5 text-xs leading-relaxed outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        ) : null}

        {/* ----- danger zone ----- */}
        <div className="border-t border-white/5 pt-3">
          <button
            onClick={() => void onDelete()}
            disabled={busy === 'delete'}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-rose-500/20 bg-rose-500/5 py-2 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
          >
            {busy === 'delete' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            删除{isGroup ? '群聊' : '会话'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
