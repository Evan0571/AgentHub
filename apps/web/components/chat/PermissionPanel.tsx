'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';

interface TerminalCommandRisk {
  level: 'read_only' | 'normal_write' | 'network' | 'docker' | 'deployment' | 'credential_sensitive' | 'destructive';
  requiresConfirmation: boolean;
  reason: string;
}

interface PermissionRequest {
  id: string;
  command: string;
  cwd: string;
  risk: TerminalCommandRisk;
  status: 'pending' | 'approved' | 'denied' | 'used';
  requestedAt: string;
  decidedAt?: string;
  decisionNote?: string;
  usedAt?: string;
  persistedPolicyId?: string;
  persistedScope?: PermissionPersistScope;
}

type PermissionPersistScope = 'exact_command' | 'cwd_risk';

interface PermissionPolicy {
  id: string;
  scope: PermissionPersistScope;
  command?: string;
  cwd: string;
  riskLevel: TerminalCommandRisk['level'];
  riskReason: string;
  enabled: boolean;
  note?: string;
  createdAt: string;
  createdFromRequestId?: string;
  revokedAt?: string;
}

interface PermissionListResult {
  requests: PermissionRequest[];
  policies?: PermissionPolicy[];
}

export function PermissionPanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [policies, setPolicies] = useState<PermissionPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeId) {
      setRequests([]);
      setPolicies([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/permissions`));
      if (!res.ok) throw new Error(`permissions ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as PermissionListResult;
      setRequests(Array.isArray(data.requests) ? data.requests : []);
      setPolicies(Array.isArray(data.policies) ? data.policies : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const pending = useMemo(() => requests.filter((request) => request.status === 'pending'), [requests]);
  const history = useMemo(() => requests.filter((request) => request.status !== 'pending').slice(0, 8), [requests]);
  const activePolicies = useMemo(() => policies.filter((policy) => policy.enabled).slice(0, 8), [policies]);

  const decide = async (requestId: string, decision: 'approve' | 'deny', persist?: PermissionPersistScope) => {
    if (!activeId || actingId) return;
    setActingId(requestId);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/permissions/${encodeURIComponent(requestId)}/${decision}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(persist ? { persist } : {}),
        },
      );
      if (!res.ok) throw new Error(`${decision} ${res.status}: ${await res.text()}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  };

  const revokePolicy = async (policyId: string) => {
    if (!activeId || actingId) return;
    setActingId(policyId);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/permissions/policies/${encodeURIComponent(policyId)}/revoke`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw new Error(`revoke ${res.status}: ${await res.text()}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  };

  if (!activeId) {
    return <EmptyPermission text="Open a conversation first." />;
  }

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-white/10 bg-bg-panel/35 p-3">
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-amber-500/25 bg-amber-500/10 text-amber-300">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text">Command Permissions</div>
            <div className="mt-0.5 text-[10px] text-text-muted">
              Dangerous terminal actions are queued here. Approve once, remember an exact command, or trust a cwd/risk scope when it is safe.
            </div>
          </div>
          <button
            onClick={() => void refresh()}
            className="rounded border border-white/10 p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
            title="Refresh permissions"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </section>

      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      <section className="space-y-2">
        <SectionTitle title="Pending" count={pending.length} />
        {pending.length === 0 ? (
          <EmptyPermission text="No commands are waiting for approval." />
        ) : (
          pending.map((request) => (
            <PermissionRow
              key={request.id}
              request={request}
              acting={actingId === request.id}
              onApprove={() => void decide(request.id, 'approve')}
              onPersistExact={() => void decide(request.id, 'approve', 'exact_command')}
              onPersistCwd={() => void decide(request.id, 'approve', 'cwd_risk')}
              onDeny={() => void decide(request.id, 'deny')}
            />
          ))
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle title="Saved Rules" count={activePolicies.length} />
        {activePolicies.length === 0 ? (
          <EmptyPermission text="No persistent permission rules." />
        ) : (
          activePolicies.map((policy) => (
            <PermissionPolicyRow
              key={policy.id}
              policy={policy}
              acting={actingId === policy.id}
              onRevoke={() => void revokePolicy(policy.id)}
            />
          ))
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle title="Recent Decisions" count={history.length} />
        {history.length === 0 ? (
          <EmptyPermission text="No decisions yet." />
        ) : (
          history.map((request) => <PermissionHistoryRow key={request.id} request={request} />)
        )}
      </section>
    </div>
  );
}

function PermissionRow({
  request,
  acting,
  onApprove,
  onPersistExact,
  onPersistCwd,
  onDeny,
}: {
  request: PermissionRequest;
  acting: boolean;
  onApprove: () => void;
  onPersistExact: () => void;
  onPersistCwd: () => void;
  onDeny: () => void;
}) {
  const canTrustCwd = canPersistCwdRisk(request.risk.level);
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5">
      <div className="flex items-start gap-2">
        <RiskIcon risk={request.risk.level} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
              {request.risk.level}
            </span>
            <span className="text-[10px] text-text-muted">{timeLabel(request.requestedAt)}</span>
          </div>
          <pre className="mt-2 max-h-24 overflow-auto rounded bg-bg/70 p-2 font-mono text-[10px] leading-relaxed text-text whitespace-pre-wrap">
            {request.command}
          </pre>
          <div className="mt-1 truncate font-mono text-[10px] text-text-muted" title={request.cwd}>
            {shortCwd(request.cwd)}
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{request.risk.reason}</div>
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={onApprove}
              disabled={acting}
              className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              Approve once
            </button>
            <button
              onClick={onPersistExact}
              disabled={acting}
              className="inline-flex items-center gap-1 rounded border border-accent/25 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
              title="Allow this exact command in this cwd on future runs."
            >
              <ShieldCheck className="h-3 w-3" />
              Always command
            </button>
            {canTrustCwd ? (
              <button
                onClick={onPersistCwd}
                disabled={acting}
                className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-50"
                title="Allow future commands with this risk level in this cwd."
              >
                <ShieldCheck className="h-3 w-3" />
                Trust cwd/risk
              </button>
            ) : null}
            <button
              onClick={onDeny}
              disabled={acting}
              className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionPolicyRow({
  policy,
  acting,
  onRevoke,
}: {
  policy: PermissionPolicy;
  acting: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-300">
              {policy.scope === 'exact_command' ? 'exact command' : 'cwd/risk'}
            </span>
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase text-text-muted">
              {policy.riskLevel}
            </span>
            <span className="text-[10px] text-text-muted">{timeLabel(policy.createdAt)}</span>
          </div>
          {policy.command ? (
            <div className="mt-1 truncate font-mono text-[10px] text-text" title={policy.command}>
              {policy.command}
            </div>
          ) : null}
          <div className="mt-1 truncate font-mono text-[10px] text-text-muted" title={policy.cwd}>
            {shortCwd(policy.cwd)}
          </div>
          <div className="mt-2 flex justify-end">
            <button
              onClick={onRevoke}
              disabled={acting}
              className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[10px] text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Revoke
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionHistoryRow({ request }: { request: PermissionRequest }) {
  return (
    <div className="rounded-md border border-white/10 bg-bg-soft/40 p-2">
      <div className="flex items-start gap-2">
        <ShieldCheck className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', request.status === 'denied' ? 'text-rose-300' : 'text-emerald-300')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase text-text-muted">{request.status}</span>
            <span className="text-[10px] text-text-muted/70">{timeLabel(request.decidedAt ?? request.usedAt ?? request.requestedAt)}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-text" title={request.command}>
            {request.command}
          </div>
        </div>
      </div>
    </div>
  );
}

function RiskIcon({ risk }: { risk: TerminalCommandRisk['level'] }) {
  const severe = risk === 'destructive' || risk === 'deployment' || risk === 'credential_sensitive';
  return (
    <span
      className={clsx(
        'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border',
        severe ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-amber-500/25 bg-amber-500/10 text-amber-300',
      )}
    >
      <ShieldAlert className="h-3.5 w-3.5" />
    </span>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{title}</span>
      <span className="text-[10px] text-text-muted/70">{count}</span>
    </div>
  );
}

function EmptyPermission({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-white/10 p-4 text-center text-xs leading-relaxed text-text-muted">
      {text}
    </div>
  );
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  const hostname = window.location.hostname.includes(':')
    ? `[${window.location.hostname}]`
    : window.location.hostname;
  return `${window.location.protocol}//${hostname}:4000${path}`;
}

function shortCwd(cwd: string): string {
  const marker = '.agenthub-workspaces';
  const idx = cwd.indexOf(marker);
  if (idx >= 0) return cwd.slice(idx);
  return cwd;
}

function canPersistCwdRisk(level: TerminalCommandRisk['level']): boolean {
  return level !== 'destructive' && level !== 'credential_sensitive';
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
