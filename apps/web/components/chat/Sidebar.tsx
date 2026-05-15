'use client';

import { useEffect, useState } from 'react';
import { Plus, Search, Settings, Sparkles, Trash2, Users } from 'lucide-react';
import { isHiddenSystemAgentId, useConversationStore } from '@/lib/store';
import { NewConversationDialog } from './NewConversationDialog';
import { ManageAgentsModal } from './ManageAgentsModal';
import { ThemeToggle } from '../ThemeToggle';
import { AgentAvatar } from '../AgentAvatar';

export function Sidebar() {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const refreshAgents = useConversationStore((s) => s.refreshAgents);
  const refreshConversations = useConversationStore((s) => s.refreshConversations);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);

  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Boot: load agents then conversations on first mount.
  useEffect(() => {
    void (async () => {
      await refreshAgents();
      await refreshConversations();
    })();
  }, [refreshAgents, refreshConversations]);

  const filtered = conversations.filter((c) =>
    !query.trim() ? true : c.title.toLowerCase().includes(query.toLowerCase()),
  );

  const onDelete = async (id: string, title: string) => {
    if (!confirm(`确认删除会话「${title}」？历史消息将一并清除。`)) return;
    await deleteConversation(id);
  };

  return (
    <aside className="flex w-72 flex-col border-r border-white/5 bg-bg-soft">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <Sparkles className="h-5 w-5 text-accent" />
        <span className="font-semibold tracking-wide">AgentHub</span>
        <ThemeToggle className="ml-auto" />
        <button
          onClick={() => setSettingsOpen(true)}
          className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          aria-label="settings"
          title="Agent 设置"
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          onClick={() => setNewOpen(true)}
          className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          aria-label="new conversation"
          title="新建会话"
        >
          <Plus className="h-4 w-4" />
        </button>
      </header>

      <div className="px-3 py-2">
        <div className="flex items-center gap-2 rounded bg-white/5 px-2 py-1.5 text-sm">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            placeholder="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-xs outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto px-2 py-1">
        {filtered.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-text-muted">
            {conversations.length === 0 ? '加载中…或点 + 新建' : '没有匹配的会话'}
          </li>
        ) : (
          filtered.map((c) => {
            const isActive = c.id === activeId;
            const visibleMembers = c.members.filter((m) => !isHiddenSystemAgentId(m.agentId));
            const primaryMember = visibleMembers[0] ?? c.members[0];
            const subtitle = c.type === 'group'
              ? `群聊 · ${visibleMembers.length} 个成员`
              : `单聊 · ${primaryMember?.name ?? ''}`;
            return (
              <li key={c.id} className="group">
                <div
                  onClick={() => setActive(c.id)}
                  className={
                    'flex w-full cursor-pointer items-start gap-2 rounded px-3 py-2 text-left text-sm transition ' +
                    (isActive ? 'bg-accent/20 text-text' : 'hover:bg-white/5')
                  }
                >
                  {c.type === 'group' ? (
                    <div
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px]"
                      style={{
                        background:
                          (primaryMember?.avatarColor ?? '#6366f1') + (isActive ? '' : '33'),
                        color: isActive ? '#fff' : primaryMember?.avatarColor ?? '#6366f1',
                      }}
                    >
                      <Users className="h-3 w-3" />
                    </div>
                  ) : (
                    <div className="mt-0.5">
                      <AgentAvatar
                        name={primaryMember?.name ?? c.title}
                        adapterId={primaryMember?.adapterId ?? ''}
                        color={primaryMember?.avatarColor ?? '#6366f1'}
                        size={20}
                      />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.title}</div>
                    <div className="truncate text-xs text-text-muted">{subtitle}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(c.id, c.title);
                    }}
                    className="rounded p-1 text-text-muted/50 opacity-0 hover:bg-rose-500/10 hover:text-rose-300 group-hover:opacity-100"
                    title="删除会话"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ul>

      {newOpen ? <NewConversationDialog onClose={() => setNewOpen(false)} /> : null}
      {settingsOpen ? <ManageAgentsModal onClose={() => setSettingsOpen(false)} /> : null}
    </aside>
  );
}
