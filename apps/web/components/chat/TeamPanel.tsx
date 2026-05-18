'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, Clock3, GitBranch, Inbox, Mail, RefreshCw, RotateCcw, UsersRound, Wrench, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { Plan, PlanTask, TaskStatus } from '@agenthub/shared-types';
import {
  baseRoleIdFromConvAgent,
  isHiddenSystemAgentId,
  roleColorFor,
  useConversationStore,
  type AgentActivityEntry,
  type AgentStateEntry,
  type ChatConversation,
} from '@/lib/store';
import { AgentAvatar } from '../AgentAvatar';

type Member = ChatConversation['members'][number];

interface MemberSummary {
  member: Member;
  tasks: PlanTask[];
  activeTask?: PlanTask;
  lastActivity?: AgentActivityEntry;
  runtime?: AgentStateEntry;
  state: 'running' | 'blocked' | 'ready' | 'waiting' | 'done' | 'idle';
}

interface TeamMailboxMessage {
  id: string;
  fromAgentName: string;
  to: string;
  subject: string;
  body: string;
  taskId?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  createdAt: string;
  readAt?: string;
}

interface TeamWakeRequest {
  id: string;
  messageId: string;
  target: string;
  subject: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  taskId?: string;
  status: 'pending' | 'claimed' | 'resolved' | 'cancelled' | 'failed';
  attempts?: number;
  maxAttempts?: number;
  nextRunAt?: string;
  lastError?: string;
  statusNote?: string;
  createdAt: string;
  updatedAt: string;
}

interface WakeQueueResult {
  wakeups?: TeamWakeRequest[];
}

interface WorkspaceReadResult {
  content: string;
}

const ACTIVE_TASKS = new Set<TaskStatus>(['running', 'awaiting-critic']);
const EMPTY_ACTIVITIES: AgentActivityEntry[] = [];
const EMPTY_AGENT_STATES: AgentStateEntry[] = [];

export function TeamPanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const conversation = useConversationStore((s) =>
    s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined,
  );
  const plan = useConversationStore((s) =>
    s.activeId ? s.plansByConv[s.activeId] : undefined,
  );
  const activities = useConversationStore((s) =>
    s.activeId ? s.agentActivityByConv[s.activeId] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES,
  );
  const agentStates = useConversationStore((s) =>
    s.activeId ? s.agentStatesByConv[s.activeId] ?? EMPTY_AGENT_STATES : EMPTY_AGENT_STATES,
  );
  const [mailboxMessages, setMailboxMessages] = useState<TeamMailboxMessage[]>([]);
  const [mailboxLoading, setMailboxLoading] = useState(false);
  const [mailboxError, setMailboxError] = useState<string | null>(null);
  const [wakeRequests, setWakeRequests] = useState<TeamWakeRequest[]>([]);
  const [wakeLoading, setWakeLoading] = useState(false);
  const [wakeActionId, setWakeActionId] = useState<string | null>(null);
  const [wakeError, setWakeError] = useState<string | null>(null);

  const refreshMailbox = useCallback(async () => {
    if (!activeId) {
      setMailboxMessages([]);
      return;
    }
    setMailboxLoading(true);
    setMailboxError(null);
    try {
      const res = await fetch(
        apiUrl(
          `/api/conversations/${encodeURIComponent(activeId)}/workspace/file?path=${encodeURIComponent('.agenthub/TEAM_MAILBOX.json')}&maxBytes=500000`,
        ),
      );
      if (res.status === 404) {
        setMailboxMessages([]);
        return;
      }
      if (!res.ok) throw new Error(`mailbox ${res.status}: ${await res.text()}`);
      const file = (await res.json()) as WorkspaceReadResult;
      const parsed = JSON.parse(file.content) as { messages?: TeamMailboxMessage[] };
      setMailboxMessages(Array.isArray(parsed.messages) ? parsed.messages : []);
    } catch (error) {
      setMailboxError(error instanceof Error ? error.message : String(error));
    } finally {
      setMailboxLoading(false);
    }
  }, [activeId]);

  const refreshWakeQueue = useCallback(async () => {
    if (!activeId) {
      setWakeRequests([]);
      return;
    }
    setWakeLoading(true);
    setWakeError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/wake?includeResolved=true&limit=20`),
      );
      if (!res.ok) throw new Error(`wake ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as WakeQueueResult;
      setWakeRequests(Array.isArray(data.wakeups) ? data.wakeups : []);
    } catch (error) {
      setWakeError(error instanceof Error ? error.message : String(error));
    } finally {
      setWakeLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    void refreshMailbox();
    void refreshWakeQueue();
    const id = window.setInterval(() => void refreshMailbox(), 4000);
    const wakeId = window.setInterval(() => void refreshWakeQueue(), 4000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(wakeId);
    };
  }, [refreshMailbox, refreshWakeQueue]);

  const members = useMemo(
    () => conversation?.members.filter((m) => !isHiddenSystemAgentId(m.agentId)) ?? [],
    [conversation],
  );
  const summaries = useMemo(
    () => buildMemberSummaries(members, plan, activities, agentStates),
    [members, plan, activities, agentStates],
  );
  const queue = useMemo(() => buildTaskQueue(plan), [plan]);
  const stats = useMemo(() => teamStats(summaries), [summaries]);
  const visibleMailboxMessages = useMemo(() => mailboxMessages.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6), [mailboxMessages]);
  const visibleWakeRequests = useMemo(() => wakeRequests.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8), [wakeRequests]);
  const blueprintLine = useMemo(() => extractBlueprintLine(conversation?.groupSystemPrompt), [conversation]);

  const updateWake = useCallback(
    async (wakeId: string, action: 'requeue' | 'cancel') => {
      if (!activeId || wakeActionId) return;
      setWakeActionId(wakeId);
      setWakeError(null);
      try {
        const res = await fetch(
          apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/wake/${encodeURIComponent(wakeId)}/${action}`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        if (!res.ok) throw new Error(`${action} ${res.status}: ${await res.text()}`);
        await refreshWakeQueue();
      } catch (error) {
        setWakeError(error instanceof Error ? error.message : String(error));
      } finally {
        setWakeActionId(null);
      }
    },
    [activeId, refreshWakeQueue, wakeActionId],
  );

  if (!activeId || !conversation) {
    return <EmptyTeam text="Select a project first." />;
  }

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-white/10 bg-bg-panel/35 p-3">
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-accent/25 bg-accent/10 text-accent">
            <UsersRound className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text">{conversation.title}</div>
            <div className="mt-0.5 text-[10px] text-text-muted">
              {members.length} members · {plan ? `${plan.tasks.length} tasks` : 'no plan yet'}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <Metric label="Running" value={stats.running} tone={stats.running ? 'running' : 'muted'} />
          <Metric label="Ready" value={stats.ready} tone={stats.ready ? 'ready' : 'muted'} />
          <Metric label="Blocked" value={stats.blocked} tone={stats.blocked ? 'bad' : 'muted'} />
          <Metric label="Idle" value={stats.idle} tone="muted" />
        </div>
      </section>

      <TeamMailboxSection
        messages={visibleMailboxMessages}
        loading={mailboxLoading}
        error={mailboxError}
        onRefresh={refreshMailbox}
      />

      <TeamWakeSection
        wakeups={visibleWakeRequests}
        loading={wakeLoading}
        error={wakeError}
        actingId={wakeActionId}
        onRefresh={refreshWakeQueue}
        onRequeue={(wakeId) => void updateWake(wakeId, 'requeue')}
        onCancel={(wakeId) => void updateWake(wakeId, 'cancel')}
      />

      <section className="space-y-2">
        <SectionTitle title="Members" subtitle="任务归属、运行状态、最近工具动作" />
        {summaries.length === 0 ? (
          <EmptyTeam text="No visible team members." />
        ) : (
          summaries.map((summary) => <MemberRow key={summary.member.agentId} summary={summary} />)
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle title="Coordination Queue" subtitle="未完成任务与交接顺序" />
        {queue.length === 0 ? (
          <EmptyTeam text={plan ? 'All tracked tasks are complete.' : 'No task graph yet. Send a project goal to create one.'} />
        ) : (
          queue.map((task) => (
            <TaskQueueRow key={task.id} task={task} conversation={conversation} />
          ))
        )}
      </section>

      <section className="rounded-lg border border-white/10 bg-bg-panel/35 p-3">
        <SectionTitle title="Collaboration Contract" subtitle="当前团队默认协作方式" compact />
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-text-muted">
          <li>组长负责拆分、派单和收口；成员只交付自己职责范围内的结果。</li>
          <li>改接口、文件结构、共享类型或验证方式时，在回复里点名受影响角色。</li>
          <li>共享决策、环境变量、Docker 服务和跨角色交接写入 TEAM_MEMORY.md。</li>
          <li>关键选择不清时先问用户；普通实现细节用可验证的本地最小闭环推进。</li>
          <li>实现类任务优先写入 workspace，并用终端或可重复命令验证。</li>
          <li>遇到阻塞要说清阻塞物、已验证事实和下一位成员需要接手什么。</li>
        </ul>
        {blueprintLine ? (
          <div className="mt-3 rounded border border-accent/20 bg-accent/5 px-2 py-1.5 text-[11px] text-accent">
            {blueprintLine}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TeamMailboxSection({
  messages,
  loading,
  error,
  onRefresh,
}: {
  messages: TeamMailboxMessage[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const unread = messages.filter((message) => !message.readAt).length;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <SectionTitle title="Mailbox" subtitle={`${unread} unread handoffs`} />
        <button
          onClick={() => void onRefresh()}
          className="rounded border border-white/10 p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="Refresh mailbox"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
          {error}
        </div>
      ) : null}
      {messages.length === 0 ? (
        <EmptyTeam text="No directed teammate messages yet." />
      ) : (
        <div className="space-y-1.5">
          {messages.map((message) => (
            <MailboxRow key={message.id} message={message} />
          ))}
        </div>
      )}
    </section>
  );
}

function MailboxRow({ message }: { message: TeamMailboxMessage }) {
  return (
    <div
      className={clsx(
        'rounded-md border bg-bg-soft/40 p-2 text-xs',
        message.readAt ? 'border-white/10 opacity-75' : 'border-accent/25',
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={clsx(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border',
            message.priority === 'urgent' || message.priority === 'high'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
              : 'border-accent/20 bg-accent/10 text-accent',
          )}
        >
          {message.readAt ? <Mail className="h-3 w-3" /> : <Inbox className="h-3 w-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-text">{message.subject}</span>
            <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase text-text-muted">
              {message.priority}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-text-muted">
            <span>{message.fromAgentName}</span>
            <span>to</span>
            <span>{message.to}</span>
            {message.taskId ? (
              <>
                <span>task</span>
                <span className="font-mono">{message.taskId}</span>
              </>
            ) : null}
          </div>
          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-muted">
            {message.body}
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamWakeSection({
  wakeups,
  loading,
  error,
  actingId,
  onRefresh,
  onRequeue,
  onCancel,
}: {
  wakeups: TeamWakeRequest[];
  loading: boolean;
  error: string | null;
  actingId: string | null;
  onRefresh: () => void;
  onRequeue: (wakeId: string) => void;
  onCancel: (wakeId: string) => void;
}) {
  const active = wakeups.filter((item) => item.status === 'pending' || item.status === 'claimed').length;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <SectionTitle title="Wake Queue" subtitle={`${active} active wakeups`} />
        <button
          onClick={() => void onRefresh()}
          className="rounded border border-white/10 p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="Refresh wake queue"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
          {error}
        </div>
      ) : null}
      {wakeups.length === 0 ? (
        <EmptyTeam text="No wake requests yet." />
      ) : (
        <div className="space-y-1.5">
          {wakeups.map((wakeup) => (
            <WakeRow
              key={wakeup.id}
              wakeup={wakeup}
              acting={actingId === wakeup.id}
              onRequeue={() => onRequeue(wakeup.id)}
              onCancel={() => onCancel(wakeup.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WakeRow({
  wakeup,
  acting,
  onRequeue,
  onCancel,
}: {
  wakeup: TeamWakeRequest;
  acting: boolean;
  onRequeue: () => void;
  onCancel: () => void;
}) {
  const canRequeue = wakeup.status === 'failed' || wakeup.status === 'cancelled';
  const canCancel = wakeup.status === 'pending' || wakeup.status === 'claimed' || wakeup.status === 'failed';
  return (
    <div
      className={clsx(
        'rounded-md border bg-bg-soft/40 p-2 text-xs',
        wakeup.status === 'failed' && 'border-rose-500/25',
        wakeup.status === 'pending' && 'border-amber-500/25',
        wakeup.status === 'claimed' && 'border-accent/25',
        (wakeup.status === 'resolved' || wakeup.status === 'cancelled') && 'border-white/10 opacity-75',
      )}
    >
      <div className="flex items-start gap-2">
        <StatusIconForWake status={wakeup.status} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-text">{wakeup.subject}</span>
            <WakeStatusPill status={wakeup.status} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-text-muted">
            <span>to {wakeup.target}</span>
            <span>{wakeup.priority}</span>
            <span>{wakeup.attempts ?? 0}/{wakeup.maxAttempts ?? 3}</span>
            {wakeup.taskId ? <span className="font-mono">{wakeup.taskId}</span> : null}
          </div>
          {wakeup.nextRunAt ? (
            <div className="mt-1 text-[10px] text-amber-300/90">
              retry at {timeLabel(wakeup.nextRunAt)}
            </div>
          ) : null}
          {wakeup.lastError ? (
            <div className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-rose-200/90">
              {wakeup.lastError}
            </div>
          ) : null}
          {(canRequeue || canCancel) ? (
            <div className="mt-2 flex gap-1.5">
              {canRequeue ? (
                <button
                  onClick={onRequeue}
                  disabled={acting}
                  className="inline-flex items-center gap-1 rounded border border-accent/25 px-2 py-1 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />
                  Requeue
                </button>
              ) : null}
              {canCancel ? (
                <button
                  onClick={onCancel}
                  disabled={acting}
                  className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[10px] text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-50"
                >
                  <XCircle className="h-3 w-3" />
                  Cancel
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WakeStatusPill({ status }: { status: TeamWakeRequest['status'] }) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
        status === 'pending' && 'bg-amber-500/15 text-amber-300',
        status === 'claimed' && 'bg-accent/15 text-accent',
        status === 'resolved' && 'bg-emerald-500/15 text-emerald-300',
        status === 'failed' && 'bg-rose-500/15 text-rose-300',
        status === 'cancelled' && 'bg-white/5 text-text-muted',
      )}
    >
      {status}
    </span>
  );
}

function StatusIconForWake({ status }: { status: TeamWakeRequest['status'] }) {
  if (status === 'failed') return <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />;
  if (status === 'resolved') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />;
  if (status === 'claimed') return <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-accent" />;
  if (status === 'cancelled') return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />;
  return <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />;
}

function MemberRow({ summary }: { summary: MemberSummary }) {
  const { member, tasks, activeTask, lastActivity, runtime, state } = summary;
  const color = roleColorFor(member.agentId, member.avatarColor);
  const counts = countTasks(tasks);

  return (
    <div className="rounded-lg border border-white/10 bg-bg-soft/45 p-2.5">
      <div className="flex items-start gap-2">
        <AgentAvatar name={member.name} adapterId={member.adapterId} color={color} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text">{member.name}</span>
            <StatePill state={state} />
          </div>
          <div className="mt-0.5 truncate text-[10px] text-text-muted">
            @{baseRoleIdFromConvAgent(member.agentId) ?? member.agentId} · {member.adapterId}
          </div>
          <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-text-muted">
            <SmallPill text={`tasks ${tasks.length}`} />
            <SmallPill text={`done ${counts.done}`} />
            <SmallPill text={`failed ${counts.failed}`} tone={counts.failed ? 'bad' : 'muted'} />
          </div>
          {activeTask ? (
            <div className="mt-2 rounded bg-accent/5 px-2 py-1.5 text-[11px] leading-relaxed text-text">
              <span className="font-mono text-[10px] text-accent">{activeTask.id}</span>
              <span className="text-text-muted"> · </span>
              {activeTask.goal}
            </div>
          ) : null}
          {lastActivity ? (
            <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-text-muted">
              <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">
                {lastActivity.title}
                <span className="text-text-muted/50"> · {lastActivity.status}</span>
              </span>
            </div>
          ) : null}
          {runtime?.reason && runtime.state !== 'idle' ? (
            <div className="mt-1 truncate text-[10px] text-text-muted">
              {stateLabel(runtime.state)} 路 {runtime.reason}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TaskQueueRow({ task, conversation }: { task: PlanTask; conversation: ChatConversation }) {
  const member = task.assigneeAgentId
    ? conversation.members.find((m) => sameAgent(m.agentId, task.assigneeAgentId))
    : undefined;

  return (
    <div className="rounded-md border border-white/10 bg-bg-soft/40 p-2 text-xs">
      <div className="flex items-start gap-2">
        <StatusIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-[10px] text-text-muted">{task.id}</span>
            <span className="text-text">{task.goal}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-text-muted">
            <span>{statusLabel(task.status)}</span>
            <span>·</span>
            <span>{member ? `@${member.name}` : 'unassigned'}</span>
            {task.inputs.length > 0 ? (
              <>
                <span>·</span>
                <span>after {task.inputs.join(', ')}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  title,
  subtitle,
  compact,
}: {
  title: string;
  subtitle: string;
  compact?: boolean;
}) {
  return (
    <div className={clsx('flex items-baseline justify-between', compact ? 'mb-0' : undefined)}>
      <span className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{title}</span>
      <span className="text-[10px] text-text-muted/70">{subtitle}</span>
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
  tone: 'running' | 'ready' | 'bad' | 'muted';
}) {
  return (
    <div className="rounded border border-white/10 bg-bg/45 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
      <div
        className={clsx(
          'mt-0.5 font-mono text-sm leading-none',
          tone === 'running' && 'text-accent',
          tone === 'ready' && 'text-amber-300',
          tone === 'bad' && 'text-rose-300',
          tone === 'muted' && 'text-text-muted',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatePill({ state }: { state: MemberSummary['state'] }) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
        state === 'running' && 'bg-accent/15 text-accent',
        state === 'blocked' && 'bg-rose-500/15 text-rose-300',
        state === 'ready' && 'bg-amber-500/15 text-amber-300',
        state === 'waiting' && 'bg-white/10 text-text-muted',
        state === 'done' && 'bg-emerald-500/15 text-emerald-300',
        state === 'idle' && 'bg-white/5 text-text-muted',
      )}
    >
      {state}
    </span>
  );
}

function stateLabel(state: string): string {
  if (state === 'waiting_user') return 'waiting';
  return state;
}

function SmallPill({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'bad' }) {
  return (
    <span className={clsx('rounded bg-white/5 px-1.5 py-0.5', tone === 'bad' && 'text-rose-300')}>
      {text}
    </span>
  );
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'running' || status === 'awaiting-critic') {
    return <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-accent" />;
  }
  if (status === 'failed') return <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />;
  if (status === 'succeeded') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />;
  if (status === 'ready') return <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />;
  return <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />;
}

function EmptyTeam({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-white/10 p-4 text-center text-xs leading-relaxed text-text-muted">
      {text}
    </div>
  );
}

function buildMemberSummaries(
  members: Member[],
  plan: Plan | undefined,
  activities: AgentActivityEntry[],
  agentStates: AgentStateEntry[],
): MemberSummary[] {
  const reversedActivities = [...activities].reverse();
  const reversedStates = [...agentStates].reverse();
  return members.map((member) => {
    const tasks = plan?.tasks.filter((task) => sameAgent(member.agentId, task.assigneeAgentId)) ?? [];
    const activeTask = tasks.find((task) => ACTIVE_TASKS.has(task.status));
    const lastActivity = reversedActivities.find((activity) =>
      activity.agentId
        ? sameAgent(member.agentId, activity.agentId)
        : activity.agentName === member.name,
    );
    const runtime = reversedStates.find((item) =>
      item.agentId ? sameAgent(member.agentId, item.agentId) : item.agentName === member.name,
    );
    return {
      member,
      tasks,
      activeTask,
      lastActivity,
      runtime,
      state: deriveMemberState(tasks, runtime),
    };
  });
}

function deriveMemberState(tasks: PlanTask[], runtime?: AgentStateEntry): MemberSummary['state'] {
  if (runtime?.state === 'waiting_user') return 'waiting';
  if (runtime?.state === 'blocked' || runtime?.state === 'failed') return 'blocked';
  if (runtime?.state === 'running') return 'running';
  if (tasks.some((task) => ACTIVE_TASKS.has(task.status))) return 'running';
  if (tasks.some((task) => task.status === 'failed')) return 'blocked';
  if (tasks.some((task) => task.status === 'ready')) return 'ready';
  if (tasks.some((task) => task.status === 'pending')) return 'waiting';
  if (tasks.some((task) => task.status === 'succeeded')) return 'done';
  return 'idle';
}

function buildTaskQueue(plan: Plan | undefined): PlanTask[] {
  if (!plan) return [];
  const priority: Record<TaskStatus, number> = {
    running: 0,
    'awaiting-critic': 1,
    failed: 2,
    ready: 3,
    pending: 4,
    cancelled: 5,
    succeeded: 6,
  };
  return [...plan.tasks]
    .filter((task) => task.status !== 'succeeded' && task.status !== 'cancelled')
    .sort((a, b) => priority[a.status] - priority[b.status])
    .slice(0, 12);
}

function teamStats(summaries: MemberSummary[]) {
  return summaries.reduce(
    (acc, item) => {
      acc[item.state] += 1;
      return acc;
    },
    {
      running: 0,
      blocked: 0,
      ready: 0,
      waiting: 0,
      done: 0,
      idle: 0,
    },
  );
}

function countTasks(tasks: PlanTask[]) {
  return tasks.reduce(
    (acc, task) => {
      if (task.status === 'succeeded') acc.done += 1;
      if (task.status === 'failed') acc.failed += 1;
      return acc;
    },
    { done: 0, failed: 0 },
  );
}

function sameAgent(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftBase = baseRoleIdFromConvAgent(left) ?? left;
  const rightBase = baseRoleIdFromConvAgent(right) ?? right;
  return leftBase === rightBase || left.endsWith(`-${rightBase}`) || right.endsWith(`-${leftBase}`);
}

function statusLabel(status: TaskStatus): string {
  if (status === 'awaiting-critic') return 'awaiting critic';
  return status;
}

function extractBlueprintLine(groupSystemPrompt: string | null | undefined): string | null {
  if (!groupSystemPrompt) return null;
  const line = groupSystemPrompt
    .split('\n')
    .map((item) => item.replace(/^-\s*/, '').trim())
    .find((item) => item.startsWith('团队蓝图'));
  return line ?? null;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  const hostname = window.location.hostname.includes(':')
    ? `[${window.location.hostname}]`
    : window.location.hostname;
  return `${window.location.protocol}//${hostname}:4000${path}`;
}
