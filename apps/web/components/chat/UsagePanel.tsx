'use client';

import { useEffect, useMemo, useState } from 'react';
import { Coins, RefreshCw } from 'lucide-react';
import { useConversationStore, prettyAgentName, roleColorFor } from '@/lib/store';
import { AgentAvatar } from '../AgentAvatar';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Real-time per-model token / cost panel. Polls while visible. */
export function UsagePanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const usage = useConversationStore((s) => (s.activeId ? s.usageByConv[s.activeId] : undefined));
  const fetchUsage = useConversationStore((s) => s.fetchUsage);

  const [adapterFilter, setAdapterFilter] = useState<string>('all');

  useEffect(() => {
    if (!activeId) return;
    void fetchUsage(activeId);
    const t = setInterval(() => void fetchUsage(activeId), 5000);
    return () => clearInterval(t);
  }, [activeId, fetchUsage]);

  const adapters = useMemo(
    () => Array.from(new Set((usage?.byModel ?? []).map((m) => m.adapterId))),
    [usage],
  );
  const rows = useMemo(
    () =>
      (usage?.byModel ?? []).filter(
        (m) => adapterFilter === 'all' || m.adapterId === adapterFilter,
      ),
    [usage, adapterFilter],
  );
  const filteredTotals = useMemo(
    () =>
      rows.reduce(
        (a, m) => ({
          calls: a.calls + m.calls,
          totalTokens: a.totalTokens + m.totalTokens,
          costUsd: a.costUsd + m.costUsd,
        }),
        { calls: 0, totalTokens: 0, costUsd: 0 },
      ),
    [rows],
  );

  if (!activeId) {
    return <div className="text-text-muted">选择一个会话查看用量。</div>;
  }

  const empty = !usage || usage.byModel.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Coins className="h-4 w-4 text-accent" />
          本会话用量
        </div>
        <button
          onClick={() => void fetchUsage(activeId)}
          className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          title="立即刷新（每 5s 自动刷新）"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {empty ? (
        <div className="rounded-md border border-white/5 bg-bg/40 px-3 py-6 text-center text-xs text-text-muted">
          还没有任何模型调用记录。
          <br />
          发条消息让 Agent 干活后这里会实时统计。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="总花费" value={fmtUsd(filteredTotals.costUsd)} accent />
            <Stat label="总 Token" value={fmtTokens(filteredTotals.totalTokens)} />
            <Stat label="调用次数" value={String(filteredTotals.calls)} />
          </div>

          {adapters.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              <FilterChip active={adapterFilter === 'all'} onClick={() => setAdapterFilter('all')}>
                全部
              </FilterChip>
              {adapters.map((a) => (
                <FilterChip
                  key={a}
                  active={adapterFilter === a}
                  onClick={() => setAdapterFilter(a)}
                >
                  {a}
                </FilterChip>
              ))}
            </div>
          ) : null}

          <div className="space-y-1">
            {rows.map((m) => (
              <div
                key={`${m.adapterId}:${m.model ?? ''}`}
                className="rounded-md border border-white/5 bg-bg/40 p-2.5"
              >
                <div className="flex items-center gap-2">
                  <AgentAvatar
                    name={prettyAgentName(m.adapterId, m.adapterId)}
                    adapterId={m.model ?? m.adapterId}
                    color={roleColorFor(m.adapterId)}
                    size={22}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">
                      {prettyAgentName(m.adapterId, m.adapterId)}
                    </div>
                    <div className="truncate text-[10px] text-text-muted">
                      {m.model ?? '—'} · {m.calls} 次调用
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-semibold text-accent">{fmtUsd(m.costUsd)}</div>
                    <div className="text-[10px] text-text-muted">{fmtTokens(m.totalTokens)} tok</div>
                  </div>
                </div>
                <div className="mt-1.5 flex gap-3 text-[10px] text-text-muted">
                  <span>输入 {fmtTokens(m.promptTokens)}</span>
                  <span>输出 {fmtTokens(m.completionTokens)}</span>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] leading-relaxed text-text-muted/70">
            费用按各 adapter 的公开报价估算（与 Langfuse 同源），仅供参考，非账单金额。
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-white/5 bg-bg/40 px-2 py-2 text-center">
      <div className={accent ? 'text-sm font-semibold text-accent' : 'text-sm font-semibold'}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] text-text-muted">{label}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'rounded px-2 py-0.5 text-[10px] ' +
        (active ? 'bg-accent/20 text-accent' : 'bg-white/5 text-text-muted hover:text-text')
      }
    >
      {children}
    </button>
  );
}
