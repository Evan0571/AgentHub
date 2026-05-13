'use client';

import { Folder, GitBranch, Monitor, Rocket } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';
import { PlanCard } from './PlanCard';

export function RightPanel() {
  const tab = useConversationStore((s) => s.rightPanelTab);
  const setTab = useConversationStore((s) => s.setRightPanelTab);
  const activeId = useConversationStore((s) => s.activeId);
  const plan = useConversationStore((s) =>
    s.activeId ? s.plansByConv[s.activeId] : undefined,
  );

  return (
    <aside className="hidden w-96 flex-col border-l border-white/5 bg-bg-soft lg:flex">
      <nav className="flex gap-1 border-b border-white/5 px-2 py-2">
        <TabBtn icon={<Folder className="h-4 w-4" />} active={tab === 'workspace'} onClick={() => setTab('workspace')}>
          Workspace
        </TabBtn>
        <TabBtn
          icon={<GitBranch className="h-4 w-4" />}
          active={tab === 'plan'}
          onClick={() => setTab('plan')}
          badge={plan ? plan.tasks.length : undefined}
        >
          Plan
        </TabBtn>
        <TabBtn icon={<Monitor className="h-4 w-4" />} active={tab === 'preview'} onClick={() => setTab('preview')}>
          Preview
        </TabBtn>
        <TabBtn icon={<Rocket className="h-4 w-4" />} active={tab === 'deploy'} onClick={() => setTab('deploy')}>
          Deploy
        </TabBtn>
      </nav>

      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {tab === 'workspace' && (
          <div className="text-text-muted">
            文件树 / Diff 视图（v1 占位 — 后续接入 Workspace 快照存储）
          </div>
        )}
        {tab === 'plan' &&
          (plan ? (
            <PlanCard plan={plan} />
          ) : (
            <div className="text-text-muted">
              当前会话还没有 Plan。在群聊里发送 <code className="rounded bg-white/10 px-1">@orchestrator 你的目标</code> 即可触发任务拆解。
            </div>
          ))}
        {tab === 'preview' && (
          <div className="text-text-muted">
            沙箱 iframe + 日志面板（v1 占位 — 待接入 E2B / WebContainer）
          </div>
        )}
        {tab === 'deploy' && (
          <div className="text-text-muted">部署状态卡片（v1 占位）</div>
        )}
      </div>

      <footer className="border-t border-white/5 px-3 py-2 text-[10px] text-text-muted/70">
        {activeId ? `conv: ${activeId}` : ''}
      </footer>
    </aside>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 rounded px-3 py-1.5 text-xs',
        active ? 'bg-white/10 text-text' : 'text-text-muted hover:bg-white/5',
      )}
    >
      {icon}
      {children}
      {badge !== undefined ? (
        <span
          className={clsx(
            'ml-0.5 rounded px-1 text-[9px] font-semibold leading-4',
            active ? 'bg-accent/30 text-accent' : 'bg-white/10 text-text-muted',
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
