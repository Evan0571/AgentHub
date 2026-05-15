'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useConversationStore, type ChatMessage, EMPTY_MESSAGES } from '@/lib/store';
import { Markdown } from './Markdown';
import { MentionText } from './MentionText';
import { AgentAvatar } from '../AgentAvatar';

export function MessageList({ conversationId }: { conversationId: string }) {
  const messages = useConversationStore(
    (s) => s.messagesByConv[conversationId] ?? EMPTY_MESSAGES,
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  // Only depend on length + the currently-streaming message's length —
  // not on the whole `messages` array (would scroll on any state change).
  const lastLen = messages[messages.length - 1]?.text.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, lastLen]);

  return (
    <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// `memo` on the row means only messages whose reference actually changed
// re-render. Since `patchMsg` in the store uses `.map((m) => m.id === id ? ...
// : m)`, untouched messages keep their object identity → memo short-circuits.
const MessageRow = memo(MessageRowImpl, (prev, next) => prev.m === next.m);

function MessageRowImpl({ m }: { m: ChatMessage }) {
  const isUser = m.senderType === 'user';

  return (
    <div className="flex gap-3">
      <AgentAvatar
        name={m.senderName}
        adapterId={m.adapterId ?? ''}
        color={m.avatarColor ?? '#6366f1'}
        size={32}
      />
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
          isUser ? (
            // User-typed text never gets markdown processing — show as-is with
            // @mention chip rendering.
            <MentionText text={m.text} conversationId={m.conversationId} />
          ) : (
            // Both agent and system messages render through Markdown (so the
            // orchestrator's **bold** / > blockquote / lists actually render).
            <Markdown text={m.text} messageId={m.id} />
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
