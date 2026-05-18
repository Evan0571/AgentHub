'use client';

import { Activity, Coins, Folder, GitBranch, Monitor, Rocket, ShieldAlert, UsersRound } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';
import { PlanCard } from './PlanCard';
import { PreviewPanel } from './PreviewPanel';
import { DeployPanel } from './DeployPanel';
import { WorkspacePanel } from './WorkspacePanel';
import { UsagePanel } from './UsagePanel';
import { AgentActivityPanel } from './AgentActivityPanel';
import { TeamPanel } from './TeamPanel';
import { PermissionPanel } from './PermissionPanel';

export function RightPanel() {
  const tab = useConversationStore((s) => s.rightPanelTab);
  const setTab = useConversationStore((s) => s.setRightPanelTab);
  const activeId = useConversationStore((s) => s.activeId);
  const plan = useConversationStore((s) =>
    s.activeId ? s.plansByConv[s.activeId] : undefined,
  );
  const activityCount = useConversationStore((s) =>
    s.activeId
      ? (s.agentActivityByConv[s.activeId] ?? []).filter((item) => item.status === 'running').length
      : 0,
  );

  return (
    <aside className="hidden w-96 flex-col border-l border-white/5 bg-bg-soft lg:flex">
      <nav className="flex gap-1 overflow-x-auto border-b border-white/5 px-2 py-2">
        <TabBtn icon={<Folder className="h-4 w-4" />} active={tab === 'workspace'} onClick={() => setTab('workspace')}>
          Workspace
        </TabBtn>
        <TabBtn
          icon={<UsersRound className="h-4 w-4" />}
          active={tab === 'team'}
          onClick={() => setTab('team')}
        >
          Team
        </TabBtn>
        <TabBtn
          icon={<Activity className="h-4 w-4" />}
          active={tab === 'activity'}
          onClick={() => setTab('activity')}
          badge={activityCount || undefined}
        >
          Activity
        </TabBtn>
        <TabBtn
          icon={<ShieldAlert className="h-4 w-4" />}
          active={tab === 'permissions'}
          onClick={() => setTab('permissions')}
        >
          Permissions
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
        <TabBtn icon={<Coins className="h-4 w-4" />} active={tab === 'usage'} onClick={() => setTab('usage')}>
          用量
        </TabBtn>
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 text-sm">
        {tab === 'workspace' && <WorkspacePanel />}
        {tab === 'team' && <TeamPanel />}
        {tab === 'activity' && <AgentActivityPanel />}
        {tab === 'permissions' && <PermissionPanel />}
        {tab === 'plan' &&
          (plan ? (
            <PlanCard plan={plan} />
          ) : (
            <div className="text-text-muted">
              当前会话还没有 Plan。在项目群里直接发送目标，系统会按团队角色触发任务拆解。
            </div>
          ))}
        {tab === 'preview' && <PreviewPanel />}
        {tab === 'deploy' && <DeployPanel />}
        {tab === 'usage' && <UsagePanel />}
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
        'flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-xs',
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
