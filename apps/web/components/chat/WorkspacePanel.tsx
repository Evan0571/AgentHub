'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { File, Folder, RefreshCw, TerminalSquare } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';

interface WorkspaceFileEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime: string;
}

interface WorkspaceListResult {
  root: string;
  files: WorkspaceFileEntry[];
  truncated: boolean;
}

interface WorkspaceReadResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  sha256: string;
}

export function WorkspacePanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const [list, setList] = useState<WorkspaceListResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkspaceReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace`));
      if (!res.ok) throw new Error(`workspace ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as WorkspaceListResult;
      setList(data);
      if (selectedPath && !data.files.some((f) => f.path === selectedPath)) {
        setSelectedPath(null);
        setSelected(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeId, selectedPath]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(id);
  }, [refresh]);

  const files = useMemo(() => list?.files ?? [], [list]);

  const openFile = async (path: string) => {
    if (!activeId) return;
    setSelectedPath(path);
    setSelected(null);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(
          `/api/conversations/${encodeURIComponent(activeId)}/workspace/file?path=${encodeURIComponent(path)}`,
        ),
      );
      if (!res.ok) throw new Error(`read ${res.status}: ${await res.text()}`);
      setSelected((await res.json()) as WorkspaceReadResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!activeId) {
    return <div className="text-sm text-text-muted">Open a conversation first.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-xs font-medium text-text">
            <TerminalSquare className="h-3.5 w-3.5 text-accent" />
            Real workspace
          </div>
          <div className="truncate font-mono text-[10px] text-text-muted" title={list?.root}>
            {list?.root ?? 'loading...'}
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded border border-white/10 p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="Refresh workspace"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 rounded-md border border-white/5 bg-bg-soft/40">
        <div className="border-b border-white/5 px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          Files {list?.truncated ? '(truncated)' : ''}
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {files.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-text-muted">
              No files yet. Ask an agent to build something; created files will appear here.
            </div>
          ) : (
            files.map((entry) => (
              <button
                key={entry.path}
                disabled={entry.type === 'directory'}
                onClick={() => void openFile(entry.path)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                  selectedPath === entry.path
                    ? 'bg-accent/20 text-text'
                    : 'text-text-muted hover:bg-white/5 hover:text-text',
                  entry.type === 'directory' && 'cursor-default hover:bg-transparent',
                )}
              >
                {entry.type === 'directory' ? <Folder className="h-3.5 w-3.5" /> : <File className="h-3.5 w-3.5" />}
                <span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
                {entry.type === 'file' ? (
                  <span className="text-[10px] text-text-muted/70">{formatBytes(entry.size ?? 0)}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/5 bg-bg-soft/40">
        <div className="border-b border-white/5 px-2 py-1.5 font-mono text-[10px] text-text-muted">
          {selected?.path ?? 'Select a file'}
        </div>
        {selected ? (
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-text whitespace-pre-wrap">
            {selected.content}
            {selected.truncated ? '\n\n/* truncated */' : ''}
          </pre>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-text-muted">
            File content from agent-written workspace will render here.
          </div>
        )}
      </div>
    </div>
  );
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  return `http://${window.location.hostname}:4000${path}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
