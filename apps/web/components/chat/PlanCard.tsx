'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import {
  CheckCircle2,
  Circle,
  CircleDashed,
  Loader2,
  XCircle,
  AlertCircle,
  ArrowDown,
} from 'lucide-react';
import type { Plan, PlanTask, TaskStatus } from '@agenthub/shared-types';

const AGENT_NAME: Record<string, string> = {
  'deepseek-v3': 'V3',
  'deepseek-r1': 'R1',
  'claude-code': 'Claude',
  codex: 'Codex',
  doubao: '豆包',
  mock: 'Mock',
};
const AGENT_COLOR: Record<string, string> = {
  'deepseek-v3': '#4f46e5',
  'deepseek-r1': '#7c3aed',
  'claude-code': '#d97706',
  codex: '#10b981',
  doubao: '#ef4444',
  mock: '#6b7280',
};

export function PlanCard({ plan }: { plan: Plan }) {
  const grouped = useMemo(() => groupByDepth(plan), [plan]);
  const stats = useMemo(() => statsFor(plan), [plan]);

  return (
    <div className="space-y-3">
      <header className="rounded-lg border border-white/5 bg-bg-soft/60 p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Root goal</span>
          <PlanStatusBadge status={plan.status} />
        </div>
        <div className="mt-1 text-sm text-text">{plan.rootGoal}</div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-text-muted">
          <span>{stats.done}/{stats.total} 完成</span>
          <span className="text-emerald-400">✓ {stats.succeeded}</span>
          <span className="text-rose-400">✕ {stats.failed}</span>
          <span className="text-accent">⟳ {stats.running}</span>
          <span>· v{plan.version}</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full bg-emerald-500/60 transition-all"
            style={{ width: stats.total ? `${(stats.succeeded / stats.total) * 100}%` : 0 }}
          />
        </div>
      </header>

      {grouped.map((layer, layerIdx) => (
        <div key={layerIdx} className="space-y-2">
          {layer.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
          {layerIdx < grouped.length - 1 ? (
            <div className="flex justify-center text-text-muted/40">
              <ArrowDown className="h-3 w-3" />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TaskRow({ task }: { task: PlanTask }) {
  const agentName = task.assigneeAgentId ? AGENT_NAME[task.assigneeAgentId] ?? task.assigneeAgentId : '?';
  const agentColor = task.assigneeAgentId ? AGENT_COLOR[task.assigneeAgentId] ?? '#6b7280' : '#6b7280';

  return (
    <div
      className={clsx(
        'rounded-lg border p-2.5 text-xs transition',
        task.status === 'running'
          ? 'border-accent/40 bg-accent/5'
          : task.status === 'succeeded'
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : task.status === 'failed'
              ? 'border-rose-500/30 bg-rose-500/5'
              : 'border-white/5 bg-bg-soft/40',
      )}
    >
      <div className="flex items-start gap-2">
        <StatusIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-[10px] text-text-muted">{task.id}</span>
            <span className="text-sm font-medium text-text">{task.goal}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
            <span
              className="rounded px-1.5 py-0.5 font-medium"
              style={{ background: agentColor + '22', color: agentColor }}
            >
              @{agentName}
            </span>
            {task.inputs.length > 0 ? (
              <span>← {task.inputs.join(', ')}</span>
            ) : (
              <span className="text-text-muted/70">入口任务</span>
            )}
            {task.acceptance.length > 0 ? (
              <span className="text-text-muted/70">
                · 验收: {task.acceptance.map((a) => a.kind).join(' / ')}
              </span>
            ) : null}
            {task.retries > 0 ? <span className="text-amber-400">重试 ×{task.retries}</span> : null}
          </div>
          {task.error ? (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-rose-400">
              <AlertCircle className="h-3 w-3" />
              {task.error.code}: {task.error.message}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'running':
    case 'awaiting-critic':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />;
    case 'succeeded':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-rose-400" />;
    case 'cancelled':
      return <CircleDashed className="h-4 w-4 shrink-0 text-text-muted" />;
    case 'ready':
      return <Circle className="h-4 w-4 shrink-0 text-text-muted" />;
    default:
      return <CircleDashed className="h-4 w-4 shrink-0 text-text-muted/60" />;
  }
}

function PlanStatusBadge({ status }: { status: Plan['status'] }) {
  const cls =
    status === 'succeeded'
      ? 'bg-emerald-500/20 text-emerald-300'
      : status === 'failed'
        ? 'bg-rose-500/20 text-rose-300'
        : status === 'executing'
          ? 'bg-accent/20 text-accent'
          : status === 'paused'
            ? 'bg-amber-500/20 text-amber-300'
            : 'bg-white/5 text-text-muted';
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider', cls)}>
      {status}
    </span>
  );
}

interface Stats {
  total: number;
  succeeded: number;
  running: number;
  failed: number;
  done: number;
}

function statsFor(plan: Plan): Stats {
  let succeeded = 0,
    running = 0,
    failed = 0,
    done = 0;
  for (const t of plan.tasks) {
    if (t.status === 'succeeded') {
      succeeded++;
      done++;
    }
    if (t.status === 'running' || t.status === 'awaiting-critic') running++;
    if (t.status === 'failed' || t.status === 'cancelled') {
      if (t.status === 'failed') failed++;
      done++;
    }
  }
  return { total: plan.tasks.length, succeeded, running, failed, done };
}

/**
 * Group tasks by DAG depth so we can render layered, top-down with arrows.
 * depth(T) = 0 if T.inputs is empty, else 1 + max(depth(input)).
 */
function groupByDepth(plan: Plan): PlanTask[][] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t] as const));
  const depthCache = new Map<string, number>();
  const depthOf = (id: string, visiting = new Set<string>()): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const t = byId.get(id);
    if (!t || t.inputs.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    const d = 1 + Math.max(...t.inputs.map((u) => depthOf(u, visiting)));
    depthCache.set(id, d);
    return d;
  };

  const layers: PlanTask[][] = [];
  for (const t of plan.tasks) {
    const d = depthOf(t.id);
    (layers[d] ??= []).push(t);
  }
  return layers.filter(Boolean);
}
