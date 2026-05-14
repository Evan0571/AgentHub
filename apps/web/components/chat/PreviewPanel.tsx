'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FileCode2, Layers, Maximize2, Play, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore, EMPTY_MESSAGES } from '@/lib/store';
import {
  buildPreview,
  canonicalName,
  extractCodeBlocks,
  isRunnable,
  type CodeBlock,
} from '@/lib/preview-utils';

export function PreviewPanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const messages = useConversationStore(
    (s) => (s.activeId ? s.messagesByConv[s.activeId] : undefined) ?? EMPTY_MESSAGES,
  );
  const previewBlockUid = useConversationStore((s) => s.previewBlockUid);
  const openPreview = useConversationStore((s) => s.openPreview);

  const allBlocks = useMemo(
    () => extractCodeBlocks(messages).filter(isRunnable),
    [messages],
  );

  // Latest-version-per-file collapse for the picker (same logic as buildPreview).
  const files = useMemo(() => {
    const byName = new Map<string, CodeBlock>();
    for (const b of allBlocks) byName.set(canonicalName(b), b);
    return [...byName.values()];
  }, [allBlocks]);

  const built = useMemo(
    () => buildPreview(allBlocks, previewBlockUid),
    [allBlocks, previewBlockUid],
  );

  if (!activeId) return <div className="text-sm text-text-muted">先打开一个会话。</div>;

  if (files.length === 0) {
    return (
      <div className="text-sm text-text-muted">
        当前会话还没有可预览的代码块。让 Agent 用{' '}
        <code className="rounded bg-white/10 px-1">```tsx path=...</code>{' '}
        输出代码，这里就会出现"运行"按钮。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <FilePicker
        files={files}
        entryName={built.entryName}
        onSelect={(uid) => openPreview(uid, { setEntry: true })}
      />
      <SandboxFrame
        html={built.html}
        kind={built.kind}
        reason={built.reason}
        entryName={built.entryName}
        fileCount={built.fileCount}
        bustKey={`${built.entryName}:${files.map((f) => f.uid).join(',')}`}
      />
    </div>
  );
}

function FilePicker({
  files,
  entryName,
  onSelect,
}: {
  files: CodeBlock[];
  entryName: string | undefined;
  onSelect: (uid: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-text-muted">
        <Layers className="h-3 w-3" />
        项目文件（{files.length}） · 入口
        <span className="ml-1 rounded bg-accent/20 px-1 py-px font-mono text-accent">
          {entryName ?? '-'}
        </span>
      </div>
      <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-white/5 bg-bg-soft/40 p-1">
        {files.map((b) => {
          const isEntry = canonicalName(b) === entryName;
          return (
            <button
              key={b.uid}
              onClick={() => onSelect(b.uid)}
              className={clsx(
                'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition',
                isEntry ? 'bg-accent/20 text-text' : 'hover:bg-white/5 text-text-muted',
              )}
              title={isEntry ? '当前入口' : '点击切为入口'}
            >
              <FileCode2 className="h-3 w-3" />
              <span className="truncate font-mono">
                {b.path ?? `${canonicalName(b)}.${b.lang}`}
              </span>
              <span className="ml-auto rounded bg-white/5 px-1 text-[9px] uppercase">
                {b.lang}
              </span>
              {isEntry ? (
                <span className="rounded bg-accent/30 px-1 text-[9px] text-accent">
                  entry
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SandboxFrame({
  html,
  kind,
  reason,
  entryName,
  fileCount,
  bustKey,
}: {
  html: string;
  kind: 'react' | 'html' | 'unsupported';
  reason?: string;
  entryName?: string;
  fileCount?: number;
  bustKey: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    setReloadKey((k) => k + 1);
  }, [bustKey]);

  const onOpenInTab = () => {
    if (kind === 'unsupported') return;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  if (kind === 'unsupported') {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
        ⚠️ {reason} —— 当前 Preview 支持 React / 单文件 HTML。
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border border-white/5 bg-white">
      <div className="flex items-center gap-2 border-b border-white/5 bg-bg-soft/80 px-2 py-1.5 text-xs">
        <Play className="h-3 w-3 text-emerald-400" />
        <span className="font-mono text-text">{entryName ?? '(entry)'}</span>
        <span className="rounded bg-white/5 px-1 py-0.5 text-[9px] uppercase text-text-muted">
          {kind}
          {fileCount && fileCount > 1 ? ` · ${fileCount} files` : ''}
        </span>
        <button
          onClick={() => setShowSource((s) => !s)}
          className="ml-auto rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          title="切换源码 / 预览"
        >
          <FileCode2 className="h-3 w-3" />
        </button>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          title="刷新"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <button
          onClick={onOpenInTab}
          className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          title="新标签页打开"
        >
          <ExternalLink className="h-3 w-3" />
        </button>
        <button
          onClick={() => iframeRef.current?.requestFullscreen?.()}
          className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
          title="全屏"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
      {showSource ? (
        <pre className="flex-1 overflow-auto bg-bg-soft p-3 font-mono text-[11px] text-text-muted">
          {html}
        </pre>
      ) : (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          title="agenthub-preview"
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
          srcDoc={html}
          className="flex-1 w-full border-0 bg-white"
        />
      )}
    </div>
  );
}
