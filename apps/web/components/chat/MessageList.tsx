'use client';

import { memo, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  HelpCircle,
  Image as ImageIcon,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
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
          {!isUser ? <AgentRunStatus message={m} /> : null}

          {m.thinking ? (
            <ThinkingBlock text={m.thinking} streaming={!!m.streaming} statusText={m.lastActivityTitle} />
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

function AgentRunStatus({ message }: { message: ChatMessage }) {
  const live = !!message.streaming;
  const now = useTicker(live);
  const startedAt = parseMs(message.startedAt ?? message.createdAt) ?? now;
  const lastEventAt = parseMs(message.lastEventAt ?? message.startedAt ?? message.createdAt) ?? startedAt;
  const finishedAt = parseMs(message.finishedAt);
  const elapsedMs = (live ? now : finishedAt ?? lastEventAt) - startedAt;
  const idleMs = live ? now - lastEventAt : 0;
  const slow = live && idleMs >= 15_000;
  const stale = live && idleMs >= 45_000;
  const waitingUser = message.lastAgentState === 'waiting_user';
  const blocked = message.lastAgentState === 'blocked';
  const failed = message.lastActivityStatus === 'failed' || message.lastAgentState === 'failed';
  const hasUsefulStatus =
    live || failed || blocked || waitingUser || message.lastActivityTitle || (message.tokenChars ?? 0) > 0;

  if (!hasUsefulStatus) return null;

  const Icon = statusIcon(message, live, stale, failed);
  const tone = failed
    ? 'failed'
    : blocked
      ? 'stale'
      : waitingUser
        ? 'waiting'
        : stale
          ? 'stale'
          : slow
            ? 'slow'
            : live
              ? 'running'
              : 'done';
  const primary = statusPrimary(message, live, slow, stale, failed);
  const detail = statusDetail(message, live, idleMs);

  return (
    <div
      className={clsx(
        'mb-2 rounded-lg border px-2.5 py-2 text-[11px] font-medium',
        tone === 'running' &&
          'border-teal-500/35 bg-teal-50 text-teal-700 dark:border-accent/25 dark:bg-accent/5 dark:text-accent',
        tone === 'slow' &&
          'border-amber-500/40 bg-amber-50 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/5 dark:text-amber-300',
        tone === 'waiting' &&
          'border-sky-500/35 bg-sky-50 text-sky-700 dark:border-sky-400/25 dark:bg-sky-400/5 dark:text-sky-300',
        tone === 'stale' &&
          'border-rose-500/35 bg-rose-50 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/5 dark:text-rose-300',
        tone === 'failed' &&
          'border-rose-500/35 bg-rose-50 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/5 dark:text-rose-300',
        tone === 'done' &&
          'border-emerald-500/35 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/5 dark:text-emerald-300',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={clsx('h-3.5 w-3.5 shrink-0', live && !stale && !failed && 'animate-pulse')} />
        <span className="min-w-0 flex-1 truncate font-medium">{primary}</span>
        <span className="shrink-0 font-mono text-[10px] opacity-80">{formatDuration(elapsedMs)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] opacity-80">
        <span>{detail}</span>
        {(message.tokenChars ?? 0) > 0 ? <span>{message.tokenChars} chars</span> : null}
        {(message.thinkingChars ?? 0) > 0 ? <span>{message.thinkingChars} log chars</span> : null}
      </div>
      {message.lastActivityDetail && live ? (
        <div className="mt-1 truncate font-mono text-[10px] opacity-75">{message.lastActivityDetail}</div>
      ) : null}
    </div>
  );
}

function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return enabled ? now : Date.now();
}

function statusIcon(message: ChatMessage, live: boolean, stale: boolean, failed: boolean) {
  if (failed || stale) return AlertTriangle;
  if (message.lastAgentState === 'waiting_user') return HelpCircle;
  if (message.lastAgentState === 'blocked') return AlertTriangle;
  if (!live) return CheckCircle2;
  if (message.lastActivityKind === 'terminal') return TerminalSquare;
  if (message.lastActivityKind === 'stream') return Activity;
  if (message.lastActivityTitle) return Wrench;
  return Clock3;
}

function statusPrimary(
  message: ChatMessage,
  live: boolean,
  slow: boolean,
  stale: boolean,
  failed: boolean,
): string {
  if (failed) return message.lastActivityTitle ?? 'Agent failed';
  if (message.lastAgentState === 'waiting_user') return 'Waiting for your answer';
  if (message.lastAgentState === 'blocked') return message.lastAgentStateReason ?? 'Agent is blocked';
  if (!live) return message.lastActivityTitle ? `Done: ${message.lastActivityTitle}` : 'Response complete';
  if (stale) return 'No update for a while';
  if (slow) return 'Still running, waiting for next stream event';
  if (message.lastActivityTitle) return message.lastActivityTitle;
  if (message.text) return 'Writing response';
  if (message.thinking) return 'Running tool loop';
  return 'Waiting for model stream';
}

function statusDetail(message: ChatMessage, live: boolean, idleMs: number): string {
  if (message.lastAgentState === 'waiting_user') {
    return message.lastAgentStateReason ?? 'answer the question panel below to continue';
  }
  if (message.lastAgentState === 'blocked') {
    return message.lastAgentStateReason ?? 'blocked; needs user or environment action';
  }
  if (!live) return message.finishedAt ? `finished ${timeAgo(message.finishedAt)}` : 'finished';
  const idle = formatDuration(idleMs);
  if (idleMs >= 45_000) return `last update ${idle} ago; backend watchdog is still active`;
  return `last update ${idle} ago`;
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

function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : null;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - (parseMs(iso) ?? Date.now());
  return `${formatDuration(ms)} ago`;
}

function ThinkingBlock({ text, streaming, statusText }: { text: string; streaming: boolean; statusText?: string }) {
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
          {streaming ? '执行中' : '工具活动'}
        </span>
        {streaming && statusText ? (
          <span className="min-w-0 truncate text-text-muted/75">{statusText}</span>
        ) : null}
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
