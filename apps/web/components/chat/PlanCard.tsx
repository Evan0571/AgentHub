'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertCircle,
  ArrowDown,
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  Info,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { Plan, PlanEdit, PlanTask, TaskStatus } from '@agenthub/shared-types';
import { isHiddenSystemAgentId, useConversationStore } from '@/lib/store';

const AGENTS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'codex', 'claude-code', 'doubao', 'mock'] as const;

const AGENT_NAME: Record<string, string> = {
  'deepseek-v4-flash': 'V4F',
  'deepseek-v4-pro': 'V4P',
  'deepseek-v3': 'V4F',
  'deepseek-r1': 'V4P',
  'claude-code': 'Claude',
  codex: 'Codex',
  doubao: '豆包',
  mock: 'Mock',
};
const AGENT_COLOR: Record<string, string> = {
  'deepseek-v4-flash': '#0f766e',
  'deepseek-v4-pro': '#2563eb',
  'deepseek-v3': '#0f766e',
  'deepseek-r1': '#2563eb',
  'claude-code': '#d97706',
  codex: '#10b981',
  doubao: '#ef4444',
  mock: '#6b7280',
};

export function PlanCard({ plan }: { plan: Plan }) {
  const grouped = useMemo(() => groupByDepth(plan), [plan]);
  const stats = useMemo(() => statsFor(plan), [plan]);
  const agents = useConversationStore((s) => s.agents);
  const assignableAgents = useMemo(
    () => agents.filter((a) => !isHiddenSystemAgentId(a.id)),
    [agents],
  );
  const [editMode, setEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const editPlan = useConversationStore((s) => s.editPlan);
  const editable = plan.status !== 'executing'; // editing live plans is risky; lock during exec

  return (
    <div className="space-y-3">
      <header className="rounded-lg border border-white/5 bg-bg-soft/60 p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Root goal</span>
          <PlanStatusBadge status={plan.status} />
          <button
            onClick={() => {
              setEditMode((m) => !m);
              setEditingId(null);
              setAdding(false);
            }}
            disabled={!editable}
            className={clsx(
              'ml-auto rounded px-2 py-0.5 text-[10px]',
              editMode
                ? 'bg-accent/20 text-accent'
                : editable
                  ? 'bg-white/5 text-text-muted hover:bg-white/10 hover:text-text'
                  : 'bg-white/5 text-text-muted/40 cursor-not-allowed',
            )}
            title={editable ? '切换编辑模式' : '执行中无法编辑 plan'}
          >
            <Pencil className="mr-1 inline h-3 w-3" />
            {editMode ? '完成编辑' : '编辑'}
          </button>
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
          {layer.map((task) =>
            editingId === task.id ? (
              <TaskEditor
                key={task.id}
                plan={plan}
                task={task}
                agents={assignableAgents}
                onCancel={() => setEditingId(null)}
                onSave={(edits) => {
                  editPlan(plan.id, edits);
                  setEditingId(null);
                }}
              />
            ) : (
              <TaskRow
                key={task.id}
                task={task}
                agents={assignableAgents}
                editMode={editMode}
                onEdit={() => setEditingId(task.id)}
                onDelete={() => {
                  if (!confirm(`确认删除 ${task.id} (${task.goal.slice(0, 30)}…)？所有下游任务将失去对它的依赖。`))
                    return;
                  editPlan(plan.id, [{ op: 'remove-task', taskId: task.id }]);
                }}
              />
            ),
          )}
          {layerIdx < grouped.length - 1 ? (
            <div className="flex justify-center text-text-muted/40">
              <ArrowDown className="h-3 w-3" />
            </div>
          ) : null}
        </div>
      ))}

      {editMode ? (
        adding ? (
          <NewTaskForm
            plan={plan}
            agents={assignableAgents}
            onCancel={() => setAdding(false)}
            onCreate={(edits) => {
              editPlan(plan.id, edits);
              setAdding(false);
            }}
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/10 py-2 text-xs text-text-muted hover:border-accent/40 hover:bg-white/5 hover:text-text"
          >
            <Plus className="h-3 w-3" />
            添加任务
          </button>
        )
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  agents,
  editMode,
  onEdit,
  onDelete,
}: {
  task: PlanTask;
  agents: Array<{ id: string; name: string; avatarColor: string }>;
  editMode: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const profile = task.assigneeAgentId ? agents.find((a) => a.id === task.assigneeAgentId) : undefined;
  const agentName = profile?.name ?? (task.assigneeAgentId ? AGENT_NAME[task.assigneeAgentId] ?? task.assigneeAgentId : '?');
  const agentColor = profile?.avatarColor ?? (task.assigneeAgentId ? AGENT_COLOR[task.assigneeAgentId] ?? '#6b7280' : '#6b7280');

  return (
    <div
      className={clsx(
        'group rounded-lg border p-2.5 text-xs transition',
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
          {task.details ? (
            <p className="mt-2 rounded bg-white/[0.03] px-2 py-1.5 text-[11px] leading-relaxed text-text-muted">
              {task.details}
            </p>
          ) : null}
          {task.deliverables?.length || task.checklist?.length ? (
            <div className="mt-2 grid gap-2 text-[10px] text-text-muted">
              {task.deliverables?.length ? (
                <div>
                  <span className="uppercase tracking-wider text-text-muted/70">Deliverables</span>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {task.deliverables.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {task.checklist?.length ? (
                <div>
                  <span className="uppercase tracking-wider text-text-muted/70">Checklist</span>
                  <ul className="mt-1 space-y-0.5">
                    {task.checklist.map((item) => (
                      <li key={item}>□ {item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {editMode ? (
          <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
            <button
              onClick={onEdit}
              className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-text"
              title="编辑"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={onDelete}
              className="rounded p-1 text-rose-400/70 hover:bg-rose-500/10 hover:text-rose-300"
              title="删除"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TaskEditor({
  plan,
  task,
  agents,
  onCancel,
  onSave,
}: {
  plan: Plan;
  task: PlanTask;
  agents: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onSave: (edits: PlanEdit[]) => void;
}) {
  const [goal, setGoal] = useState(task.goal);
  const [details, setDetails] = useState(task.details ?? '');
  const [assignee, setAssignee] = useState(task.assigneeAgentId ?? '');
  const [inputs, setInputs] = useState<string[]>(task.inputs);

  const otherTasks = plan.tasks.filter((t) => t.id !== task.id);
  const wouldCycle = (newInputs: string[]) => detectCycleWithEdit(plan, task.id, newInputs);

  const onSubmit = () => {
    const patch: Partial<PlanTask> = {};
    if (goal !== task.goal) patch.goal = goal.trim() || task.goal;
    if (details !== (task.details ?? '')) patch.details = details.trim() || undefined;
    if (assignee !== (task.assigneeAgentId ?? '')) patch.assigneeAgentId = assignee || undefined;
    if (!arraysEqual(inputs, task.inputs)) patch.inputs = inputs;
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    onSave([{ op: 'update-task', taskId: task.id, patch }]);
  };

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-xs space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-text-muted">{task.id}</span>
        <span className="text-[10px] uppercase tracking-wider text-accent">编辑中</span>
      </div>
      <label className="block">
        <span className="text-[10px] text-text-muted">目标</span>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          className="mt-0.5 w-full resize-none rounded bg-bg/60 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
      </label>
      <label className="block">
        <span className="text-[10px] text-text-muted">细节说明</span>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={4}
          className="mt-0.5 w-full resize-none rounded bg-bg/60 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-accent"
          placeholder="任务边界、输入输出、注意事项"
        />
      </label>
      <label className="block">
        <span className="text-[10px] text-text-muted">Agent</span>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="mt-0.5 w-full rounded bg-bg/60 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">（未指定）</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.id})
            </option>
          ))}
        </select>
      </label>
      <div>
        <span className="text-[10px] text-text-muted">依赖（inputs）</span>
        <div className="mt-0.5 flex items-start gap-1 rounded bg-white/[0.03] px-2 py-1 text-[10px] text-text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>勾选会形成环依赖的选项已置灰。改 inputs 不会重跑已成功的下游。</span>
        </div>
        <div className="mt-0.5 max-h-32 space-y-0.5 overflow-y-auto rounded border border-white/5 bg-bg/60 p-1">
          {otherTasks.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-text-muted/70">没有其他任务</div>
          ) : (
            otherTasks.map((t) => {
              const checked = inputs.includes(t.id);
              const next = checked ? inputs.filter((i) => i !== t.id) : [...inputs, t.id];
              const cycle = !checked && wouldCycle(next);
              return (
                <label
                  key={t.id}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px]',
                    cycle ? 'opacity-40' : 'hover:bg-white/5',
                  )}
                  title={cycle ? '勾选会形成环依赖' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={cycle}
                    onChange={() => setInputs(next)}
                  />
                  <span className="font-mono text-text-muted">{t.id}</span>
                  <span className="truncate">{t.goal}</span>
                </label>
              );
            })
          )}
        </div>
      </div>
      <div className="flex justify-end gap-1 pt-1">
        <button
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-text-muted hover:bg-white/5 hover:text-text"
        >
          <X className="mr-1 inline h-3 w-3" />
          取消
        </button>
        <button
          onClick={onSubmit}
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:bg-accent-hover"
        >
          <Check className="mr-1 inline h-3 w-3" />
          保存
        </button>
      </div>
    </div>
  );
}

function NewTaskForm({
  plan,
  agents,
  onCancel,
  onCreate,
}: {
  plan: Plan;
  agents: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onCreate: (edits: PlanEdit[]) => void;
}) {
  const [goal, setGoal] = useState('');
  const [details, setDetails] = useState('');
  const [assignee, setAssignee] = useState(agents[0]?.id ?? 'deepseek-v4-flash');
  const [inputs, setInputs] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ reasoning?: string } | null>(null);
  const suggestDeps = useConversationStore((s) => s.suggestDeps);

  const id = useMemo(() => {
    let i = plan.tasks.length + 1;
    while (plan.tasks.some((t) => t.id === `T${i}`)) i++;
    return `T${i}`;
  }, [plan.tasks]);

  const onSubmit = () => {
    if (!goal.trim()) return;
    onCreate([
      {
        op: 'add-task',
        task: {
          id,
          goal: goal.trim(),
          details: details.trim() || undefined,
          assigneeAgentId: assignee || undefined,
          inputs,
          acceptance: [{ kind: 'manual' }],
        },
      },
    ]);
  };

  const onSuggest = async () => {
    if (!goal.trim() || suggesting) return;
    setSuggesting(true);
    setSuggestion(null);
    try {
      const r = await suggestDeps(plan.id, goal.trim());
      setInputs(r.inputs);
      setSuggestion({ reasoning: r.reasoning });
    } catch (e) {
      setSuggestion({ reasoning: '（推荐失败：' + (e instanceof Error ? e.message : 'unknown') + '）' });
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-emerald-300">
        + 新任务 · {id}
      </div>
      <input
        autoFocus
        placeholder="目标（简短一句，如：实现深色模式切换）"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        className="w-full rounded bg-bg/60 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-emerald-400"
      />
      <textarea
        placeholder="细节说明：任务边界、输入输出、验收重点"
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        rows={3}
        className="w-full resize-none rounded bg-bg/60 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-emerald-400"
      />
      <select
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        className="w-full rounded bg-bg/60 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-emerald-400"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.id})
          </option>
        ))}
      </select>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-muted">前置依赖（inputs）</span>
          <button
            type="button"
            onClick={onSuggest}
            disabled={!goal.trim() || suggesting || plan.tasks.length === 0}
            className="flex items-center gap-1 rounded bg-accent/20 px-2 py-0.5 text-[10px] text-accent hover:bg-accent/30 disabled:opacity-40"
            title="让 AI 根据目标和已有任务推荐依赖"
          >
            {suggesting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {suggesting ? '推荐中…' : '智能推荐'}
          </button>
        </div>
        <div className="flex items-start gap-1 rounded bg-white/[0.03] px-2 py-1 text-[10px] text-text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            勾选 = 等该任务完成后再启动本任务。**不勾 = 立即并发执行**（适合入口/初始化）。
            不确定就点「智能推荐」让 AI 帮你判断。
          </span>
        </div>
        {suggestion?.reasoning ? (
          <div className="rounded border border-accent/20 bg-accent/5 px-2 py-1 text-[10px] text-accent">
            💡 {suggestion.reasoning}
          </div>
        ) : null}
      </div>
      <div className="max-h-28 space-y-0.5 overflow-y-auto rounded border border-white/5 bg-bg/60 p-1">
        {plan.tasks.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-text-muted/70">还没有其他任务</div>
        ) : (
          plan.tasks.map((t) => {
            const checked = inputs.includes(t.id);
            return (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setInputs(checked ? inputs.filter((i) => i !== t.id) : [...inputs, t.id])
                  }
                />
                <span className="font-mono text-text-muted">{t.id}</span>
                <span className="truncate">{t.goal}</span>
              </label>
            );
          })
        )}
      </div>
      <div className="flex justify-end gap-1 pt-1">
        <button
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-text-muted hover:bg-white/5 hover:text-text"
        >
          取消
        </button>
        <button
          onClick={onSubmit}
          disabled={!goal.trim()}
          className="rounded bg-emerald-500 px-2 py-1 text-[11px] text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          创建
        </button>
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

function groupByDepth(plan: Plan): PlanTask[][] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t] as const));
  const depthCache = new Map<string, number>();
  const depthOf = (id: string, visiting = new Set<string>()): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    if (visiting.has(id)) return 0;
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

/** Detect if applying `newInputs` for `taskId` would create a cycle in the plan. */
function detectCycleWithEdit(plan: Plan, taskId: string, newInputs: string[]): boolean {
  const adj = new Map<string, string[]>();
  for (const t of plan.tasks) {
    adj.set(t.id, t.id === taskId ? newInputs : t.inputs);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const dfs = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) return true;
      if (c === 0 && dfs(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const t of plan.tasks) if ((color.get(t.id) ?? 0) === 0 && dfs(t.id)) return true;
  return false;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
