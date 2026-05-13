'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, AtSign } from 'lucide-react';
import { MessageList } from './MessageList';
import { useConversationStore } from '@/lib/store';
import { MentionPicker, type MentionCandidate } from './MentionPicker';

interface MentionState {
  /** Index of the '@' that opened the picker. */
  triggerIdx: number;
  /** Substring after '@' up to the caret. Empty means just typed '@'. */
  query: string;
}

export function ChatPane() {
  const active = useConversationStore((s) =>
    s.conversations.find((c) => c.id === s.activeId),
  );
  const sendUserMessage = useConversationStore((s) => s.sendUserMessage);
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [active?.id]);

  // Reset on conversation switch.
  useEffect(() => {
    setText('');
    setMention(null);
  }, [active?.id]);

  const candidates: MentionCandidate[] = useMemo(() => {
    if (!active) return [];
    return active.members.map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      hint: describe(m.id),
    }));
  }, [active]);

  if (!active) {
    return (
      <main className="flex flex-1 items-center justify-center text-text-muted">
        选择或新建一个会话开始协作
      </main>
    );
  }

  /** Inspect the textarea before caret to decide whether to (re)open the picker. */
  const recomputeMention = (newText: string, caret: number) => {
    const before = newText.slice(0, caret);
    // Find the last '@'. It must be at start-of-string, after whitespace, or after newline.
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) {
      setMention(null);
      return;
    }
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1]!)) {
      setMention(null);
      return;
    }
    const query = before.slice(atIdx + 1);
    // If query contains whitespace, the user has moved past the trigger.
    if (/\s/.test(query)) {
      setMention(null);
      return;
    }
    setMention({ triggerIdx: atIdx, query });
  };

  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    recomputeMention(value, e.target.selectionStart ?? value.length);
  };

  const onSelect = (c: MentionCandidate) => {
    if (!mention) return;
    const before = text.slice(0, mention.triggerIdx);
    const after = text.slice(mention.triggerIdx + 1 + mention.query.length);
    const inserted = `@${c.id} `;
    const next = before + inserted + after;
    setText(next);
    setMention(null);
    // Restore caret after the inserted chip.
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      const ta = inputRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  const onSend = () => {
    if (!text.trim()) return;
    sendUserMessage(active.id, text);
    setText('');
    setMention(null);
  };

  const openPickerManually = () => {
    const ta = inputRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? text.length;
    // Insert an '@' at caret if there isn't one already triggering.
    if (!text.slice(0, caret).endsWith('@')) {
      const next = text.slice(0, caret) + '@' + text.slice(caret);
      setText(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caret + 1, caret + 1);
        recomputeMention(next, caret + 1);
      });
    } else {
      recomputeMention(text, caret);
      ta.focus();
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-white/5 px-5 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-accent/20 text-accent font-semibold">
          {active.title[0]}
        </div>
        <div>
          <div className="font-medium">{active.title}</div>
          <div className="text-xs text-text-muted">
            {active.members.length} 个成员 · {active.type === 'group' ? '群聊' : '单聊'}
          </div>
        </div>
      </header>

      <MessageList conversationId={active.id} />

      <footer className="relative border-t border-white/5 px-4 py-3">
        {mention ? (
          <div className="absolute bottom-full left-4 right-4 mb-2">
            <MentionPicker
              candidates={candidates}
              query={mention.query}
              onSelect={onSelect}
              onCancel={() => setMention(null)}
            />
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-lg bg-white/5 p-2">
          <button
            type="button"
            onClick={openPickerManually}
            className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
            title="@ 提及"
          >
            <AtSign className="h-4 w-4" />
          </button>
          <textarea
            ref={inputRef}
            value={text}
            onChange={onTextChange}
            onKeyUp={(e) => {
              // Re-evaluate on caret-only moves (arrow keys, mouse won't fire change).
              const ta = e.currentTarget;
              recomputeMention(ta.value, ta.selectionStart ?? ta.value.length);
            }}
            onKeyDown={(e) => {
              // Picker open: it handles Arrow/Enter/Tab/Esc. We must not also submit on Enter.
              if (mention) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder={
              active.type === 'group'
                ? '输入消息，@ 选择 Agent；Enter 发送 / Shift+Enter 换行'
                : '输入消息，Enter 发送 / Shift+Enter 换行'
            }
            className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-text-muted"
          />
          <button
            onClick={onSend}
            disabled={!text.trim()}
            className="flex h-8 w-8 items-center justify-center rounded bg-accent text-white transition hover:bg-accent-hover disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1 px-1 text-[10px] text-text-muted/70">
          {active.type === 'group'
            ? `成员：${active.members.map((m) => m.name).join('，')}`
            : `本会话默认 @${active.targetAgentId ?? active.members[0]?.id ?? ''}`}
        </div>
      </footer>
    </main>
  );
}

function describe(adapterId: string): string | undefined {
  if (adapterId === 'deepseek-v3') return '通用 · 快 · 便宜';
  if (adapterId === 'deepseek-r1') return '复杂推理 · 带思考链';
  if (adapterId === 'claude-code') return '代码 · 工具调用';
  if (adapterId === 'codex') return 'OpenAI · 代码沙箱';
  if (adapterId === 'doubao') return '中文 · 火山';
  if (adapterId === 'mock') return '本地回放 · 不烧 token';
  return undefined;
}
