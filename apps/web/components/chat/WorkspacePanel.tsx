'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, RefreshCw, Save, TerminalSquare } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';
import { FileGlyph } from './FileGlyph';

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

interface TerminalRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function WorkspacePanel() {
  const activeId = useConversationStore((s) => s.activeId);
  const [list, setList] = useState<WorkspaceListResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkspaceReadResult | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [command, setCommand] = useState('');
  const [terminal, setTerminal] = useState<TerminalRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dirty = selected !== null && draft !== selected.content;

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
      const file = (await res.json()) as WorkspaceReadResult;
      setSelected(file);
      setDraft(file.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveFile = async () => {
    if (!activeId || !selected) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/file`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: selected.path, content: draft }),
        },
      );
      if (!res.ok) throw new Error(`save ${res.status}: ${await res.text()}`);
      await openFile(selected.path);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const runCommand = async () => {
    if (!activeId || !command.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/terminal`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: command.trim(), timeoutMs: 30000 }),
        },
      );
      if (!res.ok) throw new Error(`terminal ${res.status}: ${await res.text()}`);
      setTerminal((await res.json()) as TerminalRunResult);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
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
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] font-medium transition',
                  selectedPath === entry.path
                    ? 'bg-accent/15 text-text ring-1 ring-accent/25'
                    : 'text-text/85 hover:bg-white/5 hover:text-text',
                  entry.type === 'directory' && 'cursor-default hover:bg-transparent',
                )}
              >
                <FileGlyph name={entry.path.split('/').pop() ?? entry.path} type={entry.type} />
                <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                {entry.type === 'file' ? (
                  <span className="text-[10px] text-text-muted/70">{formatBytes(entry.size ?? 0)}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/5 bg-bg-soft/40">
        <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-muted">
            {selected?.path ?? 'Select a file'}
            {dirty ? ' *' : ''}
          </span>
          {selected ? (
            <button
              onClick={() => void saveFile()}
              disabled={!dirty || saving}
              className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] text-white hover:bg-accent-hover disabled:opacity-40"
            >
              <Save className="h-3 w-3" />
              {saving ? 'Saving' : 'Save'}
            </button>
          ) : null}
        </div>
        {selected ? (
          <textarea
            value={draft + (selected.truncated ? '\n\n/* truncated */' : '')}
            onChange={(e) => setDraft(selected.truncated ? draft : e.target.value)}
            readOnly={selected.truncated}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none overflow-auto bg-transparent p-3 font-mono text-[11px] font-medium leading-relaxed text-text outline-none"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-text-muted">
            File content from agent-written workspace will render here.
          </div>
        )}
      </div>

      <div className="rounded-md border border-white/5 bg-bg-soft/40">
        <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          <TerminalSquare className="h-3.5 w-3.5" />
          Terminal
        </div>
        <div className="space-y-2 p-2">
          <div className="flex gap-1">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runCommand();
              }}
              placeholder="npm test / pnpm build / ls"
              className="min-w-0 flex-1 rounded bg-bg/60 px-2 py-1 font-mono text-[11px] outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              onClick={() => void runCommand()}
              disabled={!command.trim() || running}
              className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-[11px] text-text hover:bg-white/15 disabled:opacity-40"
            >
              <Play className={clsx('h-3 w-3', running && 'animate-pulse')} />
              Run
            </button>
          </div>
          {terminal ? (
            <pre className="max-h-40 overflow-auto rounded bg-bg/75 p-2 font-mono text-[10px] leading-relaxed text-text-muted ring-1 ring-white/5 whitespace-pre-wrap">
              {`$ ${terminal.command}\nexit ${terminal.exitCode ?? 'null'}${terminal.timedOut ? ' (timeout)' : ''}\n\n`}
              {terminal.stdout}
              {terminal.stderr ? `\n[stderr]\n${terminal.stderr}` : ''}
              {terminal.truncated ? '\n\n[output truncated]' : ''}
            </pre>
          ) : null}
        </div>
      </div>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
