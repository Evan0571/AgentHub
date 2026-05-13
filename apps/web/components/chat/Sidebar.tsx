'use client';

import { Plus, Search, Sparkles } from 'lucide-react';
import { useConversationStore } from '@/lib/store';

export function Sidebar() {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);

  return (
    <aside className="flex w-72 flex-col border-r border-white/5 bg-bg-soft">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <Sparkles className="h-5 w-5 text-accent" />
        <span className="font-semibold tracking-wide">AgentHub</span>
        <button
          className="ml-auto rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          aria-label="new conversation"
        >
          <Plus className="h-4 w-4" />
        </button>
      </header>

      <div className="px-3 py-2">
        <div className="flex items-center gap-2 rounded bg-white/5 px-2 py-1.5 text-sm">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            placeholder="搜索会话 / 消息"
            className="w-full bg-transparent text-xs outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto px-2 py-1">
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => setActive(c.id)}
              className={
                'w-full rounded px-3 py-2 text-left text-sm transition ' +
                (c.id === activeId ? 'bg-accent/20 text-text' : 'hover:bg-white/5')
              }
            >
              <div className="truncate font-medium">{c.title}</div>
              <div className="truncate text-xs text-text-muted">{c.preview}</div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
