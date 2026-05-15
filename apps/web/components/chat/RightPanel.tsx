'use client';

import { Folder, GitBranch, Monitor, Rocket } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';
import { PlanCard } from './PlanCard';
import { PreviewPanel } from './PreviewPanel';
import { DeployPanel } from './DeployPanel';
import { WorkspacePanel } from './WorkspacePanel';

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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 text-sm">
        {tab === 'workspace' && <WorkspacePanel />}
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
