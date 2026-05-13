'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useConversationStore, type ChatMessage, EMPTY_MESSAGES } from '@/lib/store';
import { Markdown } from './Markdown';
import { MentionText } from './MentionText';

export function MessageList({ conversationId }: { conversationId: string }) {
  const messages = useConversationStore(
    (s) => s.messagesByConv[conversationId] ?? EMPTY_MESSAGES,
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.text.length]);

  return (
    <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageRow({ m }: { m: ChatMessage }) {
  const isUser = m.senderType === 'user';
  const isSystem = m.senderType === 'system';

  return (
    <div className="flex gap-3">
      <div
        className="h-8 w-8 shrink-0 rounded font-semibold flex items-center justify-center text-xs"
        style={{ background: m.avatarColor ?? '#6366f1' }}
      >
        {m.senderName[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{m.senderName}</span>
          <span className="text-xs text-text-muted" suppressHydrationWarning>
            <ClientTime iso={m.createdAt} />
          </span>
        </div>

        {m.thinking ? (
          <ThinkingBlock text={m.thinking} streaming={!!m.streaming && !m.text} />
        ) : null}

        {m.text ? (
          isUser || isSystem ? (
            <MentionText text={m.text} conversationId={m.conversationId} />
          ) : (
            <Markdown text={m.text} />
          )
        ) : m.streaming && !m.thinking ? (
          <StreamingDots />
        ) : null}
      </div>
    </div>
  );
}

function StreamingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '0ms' }} />
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '150ms' }} />
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted animate-pulse" style={{ animationDelay: '300ms' }} />
    </div>
  );
}

function ClientTime({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    setText(new Date(iso).toLocaleTimeString());
  }, [iso]);
  return <>{text}</>;
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  // Auto-expand while reasoning is still streaming; user can collapse manually
  // by clicking the header. Once streaming ends, default to collapsed.
  const [userToggled, setUserToggled] = useState(false);
  const [openState, setOpenState] = useState(true);
  const open = userToggled ? openState : streaming;

  const lastLine = (() => {
    const lines = text.trim().split('\n');
    return (lines[lines.length - 1] ?? '').slice(0, 80);
  })();

  return (
    <div className="my-2 max-w-[640px] rounded-md border border-white/5 bg-bg-soft/40 transition-all">
      <button
        onClick={() => {
          setUserToggled(true);
          setOpenState(!open);
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-text-muted hover:text-text"
      >
        {streaming ? (
          <Sparkles className="h-3 w-3 animate-pulse text-accent" />
        ) : open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="font-medium">
          {streaming ? '正在思考' : '思考过程'}
        </span>
        {!open && lastLine ? (
          <span className="ml-1 truncate text-text-muted/70 italic">— {lastLine}</span>
        ) : null}
        {streaming ? (
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
        ) : null}
      </button>
      <div
        className={
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ' +
          (open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')
        }
      >
        <div className="min-h-0 overflow-hidden">
          <pre className="max-h-72 overflow-y-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-text-muted/90 whitespace-pre-wrap">
            {text}
            {streaming && <span className="inline-block h-3 w-[2px] translate-y-[2px] bg-accent animate-pulse" />}
          </pre>
        </div>
      </div>
    </div>
  );
}
