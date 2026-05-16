'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Image as ImageIcon, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore, type ChatMessage, EMPTY_MESSAGES } from '@/lib/store';
import type { MessageAttachment } from '@agenthub/shared-types';
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
    <div className={clsx('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser ? (
        <AgentAvatar
          name={m.senderName}
          adapterId={m.adapterId ?? ''}
          color={m.avatarColor ?? '#0f766e'}
          size={32}
        />
      ) : null}
      <div className={clsx('min-w-0', isUser ? 'max-w-[72%]' : 'max-w-[86%] flex-1')}>
        <div className={clsx('mb-1 flex items-baseline gap-2', isUser && 'justify-end')}>
          <span className="text-sm font-medium">{m.senderName}</span>
          <span className="text-xs text-text-muted" suppressHydrationWarning>
            <ClientTime iso={m.createdAt} />
          </span>
        </div>

        <div
          className={clsx(
            'rounded-2xl border px-3 py-2 shadow-sm',
            isUser
              ? 'rounded-tr-sm border-slate-700/20 bg-slate-800 text-white shadow-slate-900/10'
              : 'rounded-tl-sm border-white/7 bg-bg-soft/70 text-text',
          )}
        >
          {m.thinking ? (
            <ThinkingBlock text={m.thinking} streaming={!!m.streaming && !m.text} />
          ) : null}

          {m.text ? (
            isUser ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">
                <MentionText text={m.text} conversationId={m.conversationId} />
              </div>
            ) : (
              <Markdown text={m.text} messageId={m.id} />
            )
          ) : m.streaming && !m.thinking ? (
            <StreamingDots />
          ) : null}

          {m.attachments?.length ? (
            <AttachmentList conversationId={m.conversationId} attachments={m.attachments} isUser={isUser} />
          ) : null}
        </div>
      </div>
      {isUser ? (
        <AgentAvatar
          name={m.senderName}
          adapterId={m.adapterId ?? ''}
          color={m.avatarColor ?? '#0f766e'}
          size={32}
        />
      ) : null}
    </div>
  );
}

function AttachmentList({
  conversationId,
  attachments,
  isUser,
}: {
  conversationId: string;
  attachments: MessageAttachment[];
  isUser: boolean;
}) {
  return (
    <div className={clsx('mt-2 flex flex-wrap gap-2', isUser && 'justify-end')}>
      {attachments.map((file) => (
        <AttachmentView key={file.id} conversationId={conversationId} file={file} />
      ))}
    </div>
  );
}

function AttachmentView({
  conversationId,
  file,
}: {
  conversationId: string;
  file: MessageAttachment;
}) {
  const Icon = file.kind === 'image' ? ImageIcon : FileText;
  const rawUrl = apiUrl(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/raw?path=${encodeURIComponent(file.path)}&mimeType=${encodeURIComponent(file.mimeType)}`,
  );

  if (file.kind === 'image') {
    return (
      <a
        href={rawUrl}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-lg border border-white/10 bg-bg/40"
        title={`${file.name} · ${file.path}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={rawUrl} alt={file.name} className="max-h-40 max-w-64 object-cover" />
        <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted">
          <ImageIcon className="h-3 w-3" />
          <span className="max-w-48 truncate">{file.name}</span>
          <span>{formatBytes(file.size)}</span>
        </div>
      </a>
    );
  }

  return (
    <a
      href={rawUrl}
      target="_blank"
      rel="noreferrer"
      className="flex max-w-[260px] items-center gap-2 rounded-lg border border-white/10 bg-bg/40 px-2 py-1.5 text-xs hover:bg-bg-soft"
      title={file.path}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-bg-soft text-text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-text">{file.name}</span>
        <span className="block text-[10px] text-text-muted">{formatBytes(file.size)}</span>
      </span>
    </a>
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

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  const hostname = window.location.hostname.includes(':')
    ? `[${window.location.hostname}]`
    : window.location.hostname;
  return `${window.location.protocol}//${hostname}:4000${path}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
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
