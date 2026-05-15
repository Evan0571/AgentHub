'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  Rocket,
  Server,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useConversationStore,
  EMPTY_MESSAGES,
  EMPTY_DEPLOYMENTS,
  type Deployment,
} from '@/lib/store';
import {
  buildPreview,
  extractCodeBlocks,
  isRunnable,
  langFromPath,
  type CodeBlock,
} from '@/lib/preview-utils';

interface WorkspaceFileEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

interface WorkspaceListResult {
  files: WorkspaceFileEntry[];
}

interface WorkspaceReadResult {
  path: string;
  content: string;
  size: number;
}

export function DeployPanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const conv = useConversationStore((s) =>
    s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined,
  );
  const messages = useConversationStore(
    (s) => (s.activeId ? s.messagesByConv[s.activeId] : undefined) ?? EMPTY_MESSAGES,
  );
  const deployments = useConversationStore(
    (s) => (s.activeId ? s.deploymentsByConv[s.activeId] : undefined) ?? EMPTY_DEPLOYMENTS,
  );
  const triggerDeploy = useConversationStore((s) => s.triggerDeploy);
  const [workspaceBlocks, setWorkspaceBlocks] = useState<CodeBlock[]>([]);

  useEffect(() => {
    if (!activeId) {
      setWorkspaceBlocks([]);
      return;
    }

    let cancelled = false;
    const loadWorkspaceFiles = async () => {
      try {
        const listRes = await fetch(apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace`));
        if (!listRes.ok) throw new Error(`workspace ${listRes.status}`);
        const list = (await listRes.json()) as WorkspaceListResult;
        const previewable = list.files
          .filter((f) => f.type === 'file')
          .filter((f) => /\.(tsx?|jsx?|mjs|html?|css|vue)$/i.test(f.path))
          .filter((f) => (f.size ?? 0) <= 1_000_000)
          .slice(0, 60);

        const blocks = await Promise.all(
          previewable.map(async (f) => {
            const res = await fetch(
              apiUrl(
                `/api/conversations/${encodeURIComponent(activeId)}/workspace/file?path=${encodeURIComponent(f.path)}&maxBytes=1000000`,
              ),
            );
            if (!res.ok) throw new Error(`read ${f.path}: ${res.status}`);
            const file = (await res.json()) as WorkspaceReadResult;
            return {
              uid: `workspace:${file.path}:${file.size}`,
              fromMessageId: 'workspace',
              lang: langFromPath(file.path, file.content),
              path: file.path,
              code: file.content,
            } satisfies CodeBlock;
          }),
        );

        if (!cancelled) setWorkspaceBlocks(blocks.filter(isRunnable));
      } catch {
        if (!cancelled) setWorkspaceBlocks([]);
      }
    };

    void loadWorkspaceFiles();
    const timer = window.setInterval(() => void loadWorkspaceFiles(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeId]);

  const chatBlocks = useMemo(() => extractCodeBlocks(messages).filter(isRunnable), [messages]);
  const blocks = workspaceBlocks.length > 0 ? workspaceBlocks : chatBlocks;
  const built = useMemo(() => buildPreview(blocks, null), [blocks]);
  const canDeploy = built.kind !== 'unsupported' && !!built.html;
  const htmlKB = built.html ? Math.ceil(built.html.length / 1024) : 0;
  const tooLarge = htmlKB > 4096; // Vercel inline-files cap is ~4 MB
  const projectName = useMemo(
    () => (conv ? `agenthub-${slug(conv.title)}-${Date.now().toString(36).slice(-4)}` : ''),
    [conv?.id],
  );

  const [target, setTarget] = useState<'vercel' | 'mock'>('vercel');
  const [busy, setBusy] = useState(false);

  if (!activeId) return <div className="text-sm text-text-muted">先打开一个会话。</div>;

  const onDeploy = () => {
    if (!canDeploy || !conv || tooLarge) return;
    setBusy(true);
    triggerDeploy({
      conversationId: activeId,
      html: built.html,
      target,
      projectName,
    });
    // Re-enable button shortly so user can deploy again with new content.
    setTimeout(() => setBusy(false), 1500);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="rounded-lg border border-white/5 bg-bg-soft/60 p-3 space-y-2">
        <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wider text-text-muted">
          <Rocket className="h-3 w-3" />
          一键部署
        </div>

        {canDeploy ? (
          <div className="text-xs text-text-muted">
            把当前 Preview（{built.fileCount ?? 1} 个文件，入口{' '}
            <span className="rounded bg-accent/20 px-1 py-px font-mono text-accent">
              {built.entryName}
            </span>
            ）作为静态站点部署到{target === 'vercel' ? ' Vercel' : ' 本地 Mock 服务器'}。
            <span className="ml-1 text-text-muted/70">bundle ≈ {htmlKB} KB</span>
          </div>
        ) : (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-200">
            当前会话还没有可部署的内容。先让 agent 用 ```tsx path=... 输出一个 React 项目。
          </div>
        )}

        <div className="flex items-center gap-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as 'vercel' | 'mock')}
            className="rounded bg-bg/60 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="vercel">Vercel（公网 URL）</option>
            <option value="mock">本地 Mock（仅自己访问）</option>
          </select>
          <button
            onClick={onDeploy}
            disabled={!canDeploy || busy || tooLarge}
            className="flex items-center gap-1 rounded bg-accent px-3 py-1 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
            {busy ? '已发起…' : '部署'}
          </button>
        </div>

        {tooLarge ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-[11px] text-rose-300">
            ⚠️ HTML 包大小 {htmlKB} KB &gt; 4 MB，Vercel inline files API 上限。
            请让 agent 精简代码或拆分依赖。
          </div>
        ) : null}

        <details className="text-[11px] text-text-muted">
          <summary className="flex cursor-pointer items-center gap-1 select-none">
            <Info className="h-3 w-3" />
            部署须知（点击展开）
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[10px] leading-relaxed">
            <li>
              <b>包大小上限 ~4 MB</b>：Vercel 内联文件 API 单 deployment 不能超过 4 MB
              （base64 编码后）。本会话当前 bundle: <b>{htmlKB} KB</b>
              {tooLarge ? <span className="text-rose-400"> · 超限</span> : <span className="text-emerald-300"> · OK</span>}
            </li>
            <li>
              <b>项目名自动加随机后缀</b>：Vercel 免费账号一个项目名只能存一份，
              我们会以 <code className="rounded bg-white/5 px-1">{projectName.slice(0, 32)}…</code>{' '}
              这种 <code className="rounded bg-white/5 px-1">{`{title}-{时间戳}`}</code> 形式去重，
              避免覆盖之前的部署。
            </li>
            <li>
              <b>Mock URL 只能本机访问</b>：选 Mock target 时部署到 localhost:4000，
              评委演示要外网就必须用 Vercel target（需 <code className="rounded bg-white/5 px-1">VERCEL_TOKEN</code>）。
            </li>
            <li>
              .env 缺 <code className="rounded bg-white/5 px-1">VERCEL_TOKEN</code> 时会自动回退到 Mock。
            </li>
          </ul>
        </details>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {deployments.length === 0 ? (
          <div className="rounded border border-dashed border-white/5 p-4 text-center text-xs text-text-muted">
            还没有部署记录。点上方"部署"开始。
          </div>
        ) : (
          deployments.map((d) => <DeploymentRow key={d.deploymentId} d={d} />)
        )}
      </div>
    </div>
  );
}

function DeploymentRow({ d }: { d: Deployment }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!d.url) return;
    try {
      await navigator.clipboard.writeText(d.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div
      className={clsx(
        'rounded-lg border p-3 text-xs',
        d.status === 'ready'
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : d.status === 'failed' || d.status === 'rolled-back'
            ? 'border-rose-500/30 bg-rose-500/5'
            : 'border-accent/30 bg-accent/5',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={d.status} />
        <span className="font-mono text-[10px] text-text-muted">
          {d.deploymentId.slice(0, 12)}
        </span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase text-text-muted">
          {d.target}
        </span>
        <span className="ml-auto text-[10px] text-text-muted">
          {new Date(d.createdAt).toLocaleTimeString()}
        </span>
      </div>

      <div className="mt-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">状态</span>
        <div className="mt-0.5 flex items-center gap-2">
          <StatusBadge status={d.status} />
        </div>
      </div>

      {d.url ? (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">URL</span>
          <div className="mt-0.5 flex items-center gap-1 rounded bg-bg/40 px-2 py-1">
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 truncate font-mono text-[11px] text-accent hover:underline"
            >
              {d.url}
            </a>
            <button
              onClick={onCopy}
              className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
              title="复制"
            >
              {copied ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
              title="打开"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      ) : null}

      {d.errorMessage ? (
        <div className="mt-2 rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
          ⚠ {d.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function StatusIcon({ status }: { status: Deployment['status'] }) {
  switch (status) {
    case 'ready':
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case 'failed':
    case 'rolled-back':
      return <XCircle className="h-4 w-4 text-rose-400" />;
    case 'building':
    case 'queued':
      return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
    default:
      return <Server className="h-4 w-4 text-text-muted" />;
  }
}

function StatusBadge({ status }: { status: Deployment['status'] }) {
  const map = {
    queued: { text: '排队中…', cls: 'bg-accent/20 text-accent' },
    building: { text: '构建中…', cls: 'bg-accent/20 text-accent' },
    ready: { text: '已上线', cls: 'bg-emerald-500/20 text-emerald-300' },
    failed: { text: '失败', cls: 'bg-rose-500/20 text-rose-300' },
    'rolled-back': { text: '已回滚', cls: 'bg-rose-500/20 text-rose-300' },
  } as const;
  const m = map[status];
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>{m.text}</span>
  );
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  return `http://${window.location.hostname}:4000${path}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'app';
}
