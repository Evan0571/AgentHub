'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock3, FileCode2, TerminalSquare, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore, type AgentActivityEntry, type AgentStateEntry } from '@/lib/store';

const EMPTY_ACTIVITIES: AgentActivityEntry[] = [];
const EMPTY_AGENT_STATES: AgentStateEntry[] = [];

export function AgentActivityPanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const activities = useConversationStore((s) =>
    s.activeId ? s.agentActivityByConv[s.activeId] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES,
  );
  const states = useConversationStore((s) =>
    s.activeId ? s.agentStatesByConv[s.activeId] ?? EMPTY_AGENT_STATES : EMPTY_AGENT_STATES,
  );

  const ordered = useMemo(() => [...activities].reverse().slice(0, 120), [activities]);
  const running = activities.filter((item) => item.status === 'running').length;
  const waiting = states.filter((item) => item.state === 'waiting_user').length;
  const blocked = states.filter((item) => item.state === 'blocked' || item.state === 'failed').length;
  const succeeded = activities.filter((item) => item.status === 'succeeded').length;

  if (!activeId) return <EmptyActivity text="Select a project first." />;

  if (ordered.length === 0) {
    return <EmptyActivity text="No agent activity recorded." />;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        <Metric label="Running" value={running} tone={running > 0 ? 'running' : 'muted'} />
        <Metric label="Waiting" value={waiting} tone={waiting > 0 ? 'waiting' : 'muted'} />
        <Metric label="Blocked" value={blocked} tone={blocked > 0 ? 'bad' : 'muted'} />
        <Metric label="Done" value={succeeded} tone="ok" />
      </div>

      {states.length > 0 ? (
        <div className="space-y-1.5">
          {states
            .filter((item) => item.state !== 'idle')
            .slice(-8)
            .reverse()
            .map((item) => (
              <div key={item.id} className="rounded border border-white/10 bg-bg-panel/30 px-2 py-1.5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className={clsx('font-medium', stateTone(item.state))}>{stateLabel(item.state)}</span>
                  <span className="truncate text-text">{item.agentName}</span>
                </div>
                {item.reason ? <div className="mt-0.5 truncate text-text-muted">{item.reason}</div> : null}
              </div>
            ))}
        </div>
      ) : null}

      <div className="space-y-2">
        {ordered.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'running' | 'waiting' | 'ok' | 'bad' | 'muted';
}) {
  return (
    <div className="rounded border border-white/10 bg-bg-panel/35 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div
        className={clsx(
          'mt-0.5 font-mono text-lg leading-none',
          tone === 'running' && 'text-accent',
          tone === 'waiting' && 'text-sky-300',
          tone === 'ok' && 'text-emerald-300',
          tone === 'bad' && 'text-rose-300',
          tone === 'muted' && 'text-text-muted',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function stateLabel(state: string): string {
  if (state === 'waiting_user') return 'waiting';
  if (state === 'blocked') return 'blocked';
  if (state === 'failed') return 'failed';
  if (state === 'running') return 'running';
  return state;
}

function stateTone(state: string): string {
  if (state === 'waiting_user') return 'text-sky-300';
  if (state === 'blocked' || state === 'failed') return 'text-rose-300';
  if (state === 'running') return 'text-accent';
  return 'text-text-muted';
}

function ActivityRow({ item }: { item: AgentActivityEntry }) {
  const Icon = iconForActivity(item);

  return (
    <div className="rounded-md border border-white/10 bg-bg-soft/45 p-2.5">
      <div className="flex items-start gap-2">
        <span
          className={clsx(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border',
            item.status === 'running' && 'border-accent/30 bg-accent/10 text-accent',
            item.status === 'succeeded' && 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
            item.status === 'failed' && 'border-rose-400/25 bg-rose-400/10 text-rose-300',
          )}
        >
          <Icon className={clsx('h-3.5 w-3.5', item.status === 'running' && 'animate-pulse')} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-text">{item.title}</span>
            {item.toolName ? (
              <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-text-muted">
                {item.toolName}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
            <span className="truncate">{item.agentName}</span>
            <span className="text-text-muted/40">·</span>
            <ClientTime iso={item.createdAt} />
            <span className="text-text-muted/40">·</span>
            <span className={statusClass(item.status)}>{statusText(item.status)}</span>
          </div>
          {item.detail ? (
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-bg/55 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-text-muted">
              {item.detail}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function iconForActivity(item: AgentActivityEntry) {
  if (item.status === 'failed') return AlertTriangle;
  if (item.status === 'succeeded') return CheckCircle2;
  if (item.kind === 'terminal') return TerminalSquare;
  if (item.kind === 'file') return FileCode2;
  if (item.kind === 'stream') return Activity;
  if (item.status === 'running') return Clock3;
  return Wrench;
}

function statusText(status: AgentActivityEntry['status']): string {
  if (status === 'running') return 'running';
  if (status === 'succeeded') return 'done';
  return 'failed';
}

function statusClass(status: AgentActivityEntry['status']): string {
  if (status === 'running') return 'text-accent';
  if (status === 'succeeded') return 'text-emerald-300';
  return 'text-rose-300';
}

function ClientTime({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    try {
      setText(new Date(iso).toLocaleTimeString());
    } catch {
      setText(iso);
    }
  }, [iso]);
  return <>{text}</>;
}

function EmptyActivity({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-white/10 p-4 text-center text-xs leading-relaxed text-text-muted">
      {text}
    </div>
  );
}
