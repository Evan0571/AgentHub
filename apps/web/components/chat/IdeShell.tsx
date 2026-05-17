'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { EditorProps } from '@monaco-editor/react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  PanelLeftClose,
  PanelRightClose,
  Braces,
  File,
  FileCode2,
  FileText,
  Coins,
  Folder,
  GitBranch,
  Image,
  Monitor,
  Package,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Settings,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { isHiddenSystemAgentId, useConversationStore } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { Sidebar } from './Sidebar';
import { ChatPane } from './ChatPane';
import { PlanCard } from './PlanCard';
import { PreviewPanel } from './PreviewPanel';
import { DeployPanel } from './DeployPanel';
import { UsagePanel } from './UsagePanel';

const MonacoEditor = dynamic<EditorProps>(
  () => import('@monaco-editor/react').then((mod) => mod.Editor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-bg font-mono text-xs text-text-muted">
        Loading editor...
      </div>
    ),
  },
);

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
  startedCwd: string;
  shell: 'powershell' | 'pwsh';
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface TerminalEntry {
  id: string;
  kind: 'command' | 'result' | 'system';
  prompt?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  text?: string;
}

interface TerminalSession {
  id: string;
  title: string;
  cwd: string | null;
  input: string;
  running: boolean;
  history: string[];
  historyIndex: number | null;
  entries: TerminalEntry[];
}

interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
  children: WorkspaceTreeNode[];
}

type ResizeTarget = 'project' | 'chat' | 'chatList' | 'terminal';

export function IdeShell() {
  const activeId = useConversationStore((s) => s.activeId);
  const [projectWidth, setProjectWidth] = useState(300);
  const [chatWidth, setChatWidth] = useState(720);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [chatListWidth, setChatListWidth] = useState(260);
  const [terminalHeight, setTerminalHeight] = useState(190);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const clearSelectedPath = useCallback(() => setSelectedPath(null), []);

  // Never let BOTH sides collapse into a blank screen — if collapsing one
  // would hide everything, re-open the chat so there's always content.
  useEffect(() => {
    if (!leftOpen && !rightOpen) setRightOpen(true);
  }, [leftOpen, rightOpen]);

  useEffect(() => {
    setSelectedPath(null);
  }, [activeId]);

  const beginResize = (target: ResizeTarget, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startProject = projectWidth;
    const startChat = chatWidth;
    const startChatList = chatListWidth;
    const startTerminal = terminalHeight;

    const onMove = (ev: MouseEvent) => {
      if (target === 'project') {
        setProjectWidth(clamp(startProject + ev.clientX - startX, 220, 520));
      } else if (target === 'chat') {
        setChatWidth(clamp(startChat - (ev.clientX - startX), 460, 980));
      } else if (target === 'chatList') {
        setChatListWidth(clamp(startChatList + ev.clientX - startX, 210, 420));
      } else {
        setTerminalHeight(clamp(startTerminal - (ev.clientY - startY), 120, 420));
      }
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    document.body.style.cursor = target === 'terminal' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* ---- Workspace side (file/Plan panel + code editor collapse together) ---- */}
      {leftOpen ? (
        <>
          <section
            className="flex min-w-0 shrink-0 flex-col border-r border-white/5 bg-bg-soft"
            style={{ width: projectWidth }}
          >
            <ProjectPanel selectedPath={selectedPath} onSelectPath={setSelectedPath} />
          </section>
          <ResizeHandle onMouseDown={(e) => beginResize('project', e)} />
          <main className="flex min-w-[420px] flex-1 flex-col overflow-hidden bg-bg">
            <CodeWorkbench
              selectedPath={selectedPath}
              terminalHeight={terminalHeight}
              onResizeTerminal={(e) => beginResize('terminal', e)}
              onMissingPath={clearSelectedPath}
            />
          </main>
        </>
      ) : (
        <ExpandRail side="left" label="工作区" onClick={() => setLeftOpen(true)} />
      )}

      {/* ---- Center divider: both collapse handles live here, faint until
              the mouse comes near the dividing line ---- */}
      {leftOpen || rightOpen ? (
        <div className="group/divider relative flex w-2 shrink-0 items-center justify-center">
          <div
            onMouseDown={
              leftOpen && rightOpen ? (e) => beginResize('chat', e) : undefined
            }
            className={clsx(
              'h-full w-full bg-white/[0.04] transition-colors group-hover/divider:bg-accent/40',
              leftOpen && rightOpen ? 'cursor-col-resize' : '',
            )}
            aria-label="拖动调整左右占比"
          />
          {leftOpen ? (
            <button
              onClick={() => setLeftOpen(false)}
              title="收起工作区（含代码区）"
              className="absolute right-full top-1/2 -translate-y-1/2 rounded-l-md border border-r-0 border-white/10 bg-bg-panel/90 p-1 text-text-muted opacity-0 transition-opacity duration-150 hover:bg-white/10 hover:text-text group-hover/divider:opacity-100"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          ) : null}
          {rightOpen ? (
            <button
              onClick={() => setRightOpen(false)}
              title="收起群聊"
              className="absolute left-full top-1/2 -translate-y-1/2 rounded-r-md border border-l-0 border-white/10 bg-bg-panel/90 p-1 text-text-muted opacity-0 transition-opacity duration-150 hover:bg-white/10 hover:text-text group-hover/divider:opacity-100"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ---- Chat side ---- */}
      {rightOpen ? (
        <section
          className={clsx(
            'flex min-w-0 border-l border-white/5 bg-bg-soft',
            // Fixed (resizable) width only when the workspace is also shown;
            // if the workspace is collapsed, the chat fills the whole screen.
            leftOpen ? 'shrink-0' : 'flex-1',
          )}
          style={leftOpen ? { width: chatWidth } : undefined}
        >
          <div className="min-w-0 shrink-0" style={{ width: chatListWidth }}>
            <Sidebar className="w-full" />
          </div>
          <ResizeHandle onMouseDown={(e) => beginResize('chatList', e)} />
          <ChatPane />
        </section>
      ) : (
        <ExpandRail side="right" label="群聊" onClick={() => setRightOpen(true)} />
      )}
    </div>
  );
}

function ExpandRail({
  side,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`展开${label}`}
      className={clsx(
        'flex w-9 shrink-0 flex-col items-center gap-2 bg-bg-soft py-3 text-text-muted hover:text-text',
        side === 'left' ? 'border-r border-white/5' : 'border-l border-white/5',
      )}
    >
      {side === 'left' ? (
        <ChevronRight className="h-4 w-4" />
      ) : (
        <ChevronLeft className="h-4 w-4" />
      )}
      <span className="[writing-mode:vertical-rl] text-[10px] tracking-widest">{label}</span>
    </button>
  );
}

function ProjectPanel({
  selectedPath,
  onSelectPath,
}: {
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
}) {
  const tab = useConversationStore((s) => s.rightPanelTab);
  const setTab = useConversationStore((s) => s.setRightPanelTab);
  const activeId = useConversationStore((s) => s.activeId);
  const activeConversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === s.activeId),
  );
  const plan = useConversationStore((s) =>
    s.activeId ? s.plansByConv[s.activeId] : undefined,
  );
  const visibleMemberCount =
    activeConversation?.members.filter((m) => !isHiddenSystemAgentId(m.agentId)).length ?? 0;

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/5 bg-bg-soft px-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Folder className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
            Workspace
          </div>
          <div className="truncate text-sm font-semibold text-text">
            {activeConversation?.title ?? 'No project'}
          </div>
          <div className="truncate text-[10px] text-text-muted">
            {activeConversation
              ? `${activeConversation.type === 'group' ? 'Group project' : 'Single chat'} · ${visibleMemberCount} members`
              : 'Select or create a project'}
          </div>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-white/5 bg-bg-panel/30 p-1.5 [scrollbar-width:thin]">
        <ProjectTab icon={<Folder className="h-3.5 w-3.5" />} active={tab === 'workspace'} onClick={() => setTab('workspace')}>
          Files
        </ProjectTab>
        <ProjectTab
          icon={<GitBranch className="h-3.5 w-3.5" />}
          active={tab === 'plan'}
          onClick={() => setTab('plan')}
          badge={plan ? plan.tasks.length : undefined}
        >
          Plan
        </ProjectTab>
        <ProjectTab icon={<Monitor className="h-3.5 w-3.5" />} active={tab === 'preview'} onClick={() => setTab('preview')}>
          Preview
        </ProjectTab>
        <ProjectTab icon={<Rocket className="h-3.5 w-3.5" />} active={tab === 'deploy'} onClick={() => setTab('deploy')}>
          Deploy
        </ProjectTab>
        <ProjectTab icon={<Coins className="h-3.5 w-3.5" />} active={tab === 'usage'} onClick={() => setTab('usage')}>
          Cost
        </ProjectTab>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'workspace' ? (
          <WorkspaceTree selectedPath={selectedPath} onSelectPath={onSelectPath} />
        ) : null}
        {tab === 'plan' ? (
          plan ? (
            <PlanCard plan={plan} />
          ) : (
            <EmptyPanel text="当前项目还没有 Plan。直接在右侧群聊里描述目标，架构师会生成任务文档和执行 DAG。" />
          )
        ) : null}
        {tab === 'preview' ? <PreviewPanel /> : null}
        {tab === 'deploy' ? <DeployPanel /> : null}
        {tab === 'usage' ? <UsagePanel /> : null}
      </div>
    </aside>
  );
}

function WorkspaceTree({
  selectedPath,
  onSelectPath,
}: {
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
}) {
  const activeId = useConversationStore((s) => s.activeId);
  const [list, setList] = useState<WorkspaceListResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
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
      const selectedStillExists =
        selectedPath !== null &&
        data.files.some((f) => f.type === 'file' && f.path === selectedPath);
      if (!selectedStillExists) {
        const firstFile = data.files.find((f) => f.type === 'file') ?? null;
        onSelectPath(firstFile?.path ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeId, onSelectPath, selectedPath]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const files = useMemo(() => list?.files ?? [], [list]);
  const tree = useMemo(() => buildWorkspaceTree(files), [files]);

  useEffect(() => {
    if (!list) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const entry of list.files) {
        if (entry.type === 'directory' && entry.path.split('/').length <= 1) {
          next.add(entry.path);
        }
      }
      return next;
    });
  }, [list]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!activeId) return <EmptyPanel text="先打开一个项目会话。" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Workspace</div>
          <div className="truncate font-mono text-[10px] text-text-muted/80" title={list?.root}>
            {list?.root ?? 'loading...'}
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded border border-white/10 p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="Refresh"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="space-y-0.5">
        {tree.length === 0 ? (
          <EmptyPanel text="还没有文件。让 Agent 写入 workspace 后会出现在这里。" />
        ) : (
          tree.map((node) => (
            <TreeNodeRow
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={toggleDir}
              onSelectPath={onSelectPath}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelectPath,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelectPath: (path: string) => void;
}) {
  const isDirectory = node.type === 'directory';
  const isOpen = isDirectory && expanded.has(node.path);
  const isSelected = selectedPath === node.path;
  const Icon = isDirectory ? Folder : iconForFile(node.name);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDirectory) onToggle(node.path);
          else onSelectPath(node.path);
        }}
        className={clsx(
          'group flex w-full items-center gap-1.5 rounded py-1.5 pr-2 text-left text-xs transition',
          isSelected
            ? 'bg-accent/20 text-text'
            : 'text-text-muted hover:bg-white/5 hover:text-text',
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
      >
        {isDirectory ? (
          isOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-text-muted/70" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-text-muted/70" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon className={clsx('h-3.5 w-3.5 shrink-0', iconColorForFile(node.name, isDirectory))} />
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        {!isDirectory && node.size !== undefined ? (
          <span className="text-[9px] text-text-muted/50 opacity-0 group-hover:opacity-100">
            {formatBytes(node.size)}
          </span>
        ) : null}
      </button>
      {isOpen && node.children.length > 0 ? (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelectPath={onSelectPath}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CodeWorkbench({
  selectedPath,
  terminalHeight,
  onResizeTerminal,
  onMissingPath,
}: {
  selectedPath: string | null;
  terminalHeight: number;
  onResizeTerminal: (e: React.MouseEvent) => void;
  onMissingPath: () => void;
}) {
  const activeId = useConversationStore((s) => s.activeId);
  const { theme } = useTheme();
  const [file, setFile] = useState<WorkspaceReadResult | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalSeq, setTerminalSeq] = useState(1);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>(() => [
    createTerminalSession(1),
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState(() => terminalSessions[0]!.id);
  const dirty = file !== null && draft !== file.content;
  const lineCount = useMemo(() => Math.max(1, draft.split('\n').length), [draft]);
  const fileName = file?.path.split('/').pop() ?? selectedPath?.split('/').pop() ?? 'untitled';
  const pathParts = (file?.path ?? selectedPath ?? '').split('/').filter(Boolean);
  const language = languageForFile(fileName);

  const loadFile = useCallback(async () => {
    if (!activeId || !selectedPath) {
      setFile(null);
      setDraft('');
      return;
    }
    // Binary (image / pdf / archive / font …): never fetch as text — that's
    // what produced the garbled mojibake. Image preview / placeholder is
    // handled in the render branch below.
    if (isBinaryName(selectedPath)) {
      setFile(null);
      setDraft('');
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(
          `/api/conversations/${encodeURIComponent(activeId)}/workspace/file?path=${encodeURIComponent(selectedPath)}&maxBytes=1000000`,
        ),
      );
      if (res.status === 404) {
        onMissingPath();
        setFile(null);
        setDraft('');
        return;
      }
      if (!res.ok) throw new Error(`read ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as WorkspaceReadResult;
      setFile(data);
      setDraft(data.content);
    } catch (e) {
      setFile(null);
      setDraft('');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeId, onMissingPath, selectedPath]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  useEffect(() => {
    const first = createTerminalSession(1);
    setTerminalSeq(1);
    setTerminalSessions([first]);
    setActiveTerminalId(first.id);
  }, [activeId]);

  const saveFile = async () => {
    if (!activeId || !file || file.truncated) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/file`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, content: draft }),
        },
      );
      if (!res.ok) throw new Error(`save ${res.status}: ${await res.text()}`);
      await loadFile();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateTerminalInput = (id: string, input: string) => {
    setTerminalSessions((sessions) =>
      sessions.map((session) =>
        session.id === id ? { ...session, input, historyIndex: null } : session,
      ),
    );
  };

  const addTerminal = () => {
    const nextSeq = terminalSeq + 1;
    const session = createTerminalSession(nextSeq);
    setTerminalSeq(nextSeq);
    setTerminalSessions((sessions) => [...sessions, session]);
    setActiveTerminalId(session.id);
    setTerminalOpen(true);
  };

  const closeTerminal = (id: string) => {
    setTerminalSessions((sessions) => {
      const next = sessions.filter((session) => session.id !== id);
      if (next.length === 0) {
        const fresh = createTerminalSession(1);
        setTerminalSeq(1);
        setActiveTerminalId(fresh.id);
        setTerminalOpen(false);
        return [fresh];
      }
      if (activeTerminalId === id) {
        setActiveTerminalId(next[Math.max(0, sessions.findIndex((s) => s.id === id) - 1)]?.id ?? next[0]!.id);
      }
      return next;
    });
  };

  const clearTerminal = (id: string) => {
    setTerminalSessions((sessions) =>
      sessions.map((session) => (session.id === id ? { ...session, entries: [] } : session)),
    );
  };

  const recallTerminalHistory = (id: string, direction: 'prev' | 'next') => {
    setTerminalSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== id || session.history.length === 0) return session;
        const current =
          session.historyIndex ??
          (direction === 'prev' ? session.history.length : session.history.length - 1);
        const nextIndex =
          direction === 'prev'
            ? Math.max(0, current - 1)
            : Math.min(session.history.length, current + 1);
        return {
          ...session,
          historyIndex: nextIndex >= session.history.length ? null : nextIndex,
          input: nextIndex >= session.history.length ? '' : session.history[nextIndex] ?? '',
        };
      }),
    );
  };

  const runTerminalCommand = async (id: string) => {
    if (!activeId) return;
    const session = terminalSessions.find((item) => item.id === id);
    if (!session || session.running) return;
    const command = session.input.trim();
    if (!command) return;

    if (command.toLowerCase() === 'clear' || command.toLowerCase() === 'cls') {
      clearTerminal(id);
      updateTerminalInput(id, '');
      return;
    }

    const prompt = formatTerminalPrompt(session.cwd);
    const commandEntry: TerminalEntry = {
      id: `cmd-${Date.now()}`,
      kind: 'command',
      prompt,
      command,
    };

    setTerminalSessions((sessions) =>
      sessions.map((item) =>
        item.id === id
          ? {
              ...item,
              input: '',
              running: true,
              historyIndex: null,
              history: [...item.history, command].slice(-100),
              entries: [...item.entries, commandEntry],
            }
          : item,
      ),
    );
    setError(null);

    try {
      const res = await fetch(
        apiUrl(`/api/conversations/${encodeURIComponent(activeId)}/workspace/terminal`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command,
            cwd: session.cwd ?? undefined,
            timeoutMs: 30000,
          }),
        },
      );
      if (!res.ok) throw new Error(`terminal ${res.status}: ${await res.text()}`);
      const result = (await res.json()) as TerminalRunResult;
      const resultEntry: TerminalEntry = {
        id: `res-${Date.now()}`,
        kind: 'result',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
      setTerminalSessions((sessions) =>
        sessions.map((item) =>
          item.id === id
            ? {
                ...item,
                cwd: result.cwd,
                running: false,
                entries: [...item.entries, resultEntry],
              }
            : item,
        ),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setTerminalSessions((sessions) =>
        sessions.map((item) =>
          item.id === id
            ? {
                ...item,
                running: false,
                entries: [
                  ...item.entries,
                  {
                    id: `err-${Date.now()}`,
                    kind: 'system',
                    text: message,
                  },
                ],
              }
            : item,
        ),
      );
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-white/5 bg-bg-soft">
        <div className="flex h-10 items-end gap-1 bg-bg-panel/45 px-2 pt-1">
          <div
            className={clsx(
              'flex h-9 min-w-0 max-w-[360px] items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs',
              file
                ? 'border-white/10 bg-bg text-text'
                : 'border-transparent bg-transparent text-text-muted',
            )}
          >
            {file ? (
              (() => {
                const Icon = iconForFile(fileName);
                return <Icon className={clsx('h-3.5 w-3.5 shrink-0', iconColorForFile(fileName, false))} />;
              })()
            ) : (
              <File className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate font-mono">{fileName}</span>
            {dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
          </div>
          <div className="ml-auto flex items-center gap-1 pb-1">
            {error ? <span className="max-w-[360px] truncate text-xs text-rose-300">{error}</span> : null}
            <button
              onClick={() => void loadFile()}
              disabled={!selectedPath || loading}
              className="rounded border border-white/10 p-1.5 text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-40"
              title="Reload file"
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
            <button
              onClick={() => void saveFile()}
              disabled={!dirty || saving || !!file?.truncated}
              className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
        <div className="flex h-8 items-center gap-1 overflow-hidden px-4 text-[11px] text-text-muted">
          {pathParts.length > 0 ? (
            pathParts.map((part, index) => (
              <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="text-text-muted/40">/</span> : null}
                <span className={clsx('truncate font-mono', index === pathParts.length - 1 && 'text-text')}>
                  {part}
                </span>
              </span>
            ))
          ) : (
            <span>Select a file from Workspace</span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 bg-bg">
        {selectedPath && isImageName(selectedPath) ? (
          <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-bg p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={
                activeId
                  ? apiUrl(
                      `/api/conversations/${encodeURIComponent(activeId)}/workspace/raw?path=${encodeURIComponent(
                        selectedPath,
                      )}&mimeType=${encodeURIComponent(mimeForName(selectedPath))}`,
                    )
                  : ''
              }
              alt={selectedPath.split('/').pop() ?? 'image'}
              className="max-h-full max-w-full rounded border border-white/10 object-contain"
            />
          </div>
        ) : selectedPath && isBinaryName(selectedPath) ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-text-muted">
            二进制文件（{extensionOf(selectedPath).toUpperCase()}），不支持文本预览。
          </div>
        ) : file ? (
          <div className="h-full min-h-0 bg-bg">
            <MonacoEditor
              key={file.path}
              theme={theme === 'light' ? 'vs' : 'vs-dark'}
              language={language}
              value={draft}
              onChange={(value) => setDraft(value ?? '')}
              options={{
                automaticLayout: true,
                bracketPairColorization: { enabled: true },
                cursorBlinking: 'smooth',
                fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace',
                fontLigatures: true,
                fontSize: 12,
                guides: { bracketPairs: true, indentation: true },
                lineHeight: 22,
                minimap: { enabled: true, scale: 0.8 },
                padding: { top: 12, bottom: 12 },
                readOnly: file.truncated,
                renderLineHighlight: 'line',
                renderWhitespace: 'selection',
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                tabSize: 2,
                wordWrap: 'on',
              }}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-text-muted">
            从左侧 Workspace 选择文件。Agent 写入的新文件会自动出现在项目树里。
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-white/5 bg-bg-panel/45 px-3 font-mono text-[10px] text-text-muted">
        <span>{file ? extensionOf(fileName).toUpperCase() || 'TEXT' : 'NO FILE'}</span>
        <span>{lineCount} lines</span>
        <span>{file ? formatBytes(file.size) : '0 B'}</span>
        {file?.truncated ? <span className="text-amber-400">read-only: truncated</span> : null}
        {dirty ? <span className="ml-auto text-accent">modified</span> : <span className="ml-auto">saved</span>}
      </div>

      {terminalOpen ? (
        <>
          <button
            className="h-1.5 shrink-0 cursor-row-resize bg-white/5 hover:bg-accent/30"
            onMouseDown={onResizeTerminal}
            aria-label="resize terminal"
          />
          <TerminalPane
            height={terminalHeight}
            sessions={terminalSessions}
            activeId={activeTerminalId}
            onActivate={setActiveTerminalId}
            onAdd={addTerminal}
            onClose={closeTerminal}
            onClear={clearTerminal}
            onInput={updateTerminalInput}
            onHistory={recallTerminalHistory}
            onRun={runTerminalCommand}
            onCollapse={() => setTerminalOpen(false)}
          />
        </>
      ) : (
        <button
          onClick={() => setTerminalOpen(true)}
          className="flex shrink-0 items-center justify-center gap-2 border-t border-white/5 bg-bg-soft px-3 py-2 text-xs text-text-muted hover:text-text"
        >
          <ChevronUp className="h-3.5 w-3.5" />
          Open Terminal
        </button>
      )}
    </section>
  );
}

function TerminalPane({
  height,
  sessions,
  activeId,
  onActivate,
  onAdd,
  onClose,
  onClear,
  onInput,
  onHistory,
  onRun,
  onCollapse,
}: {
  height: number;
  sessions: TerminalSession[];
  activeId: string;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onClear: (id: string) => void;
  onInput: (id: string, value: string) => void;
  onHistory: (id: string, direction: 'prev' | 'next') => void;
  onRun: (id: string) => void;
  onCollapse: () => void;
}) {
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const agentRuns = useConversationStore((s) =>
    s.activeId ? s.agentTerminalByConv[s.activeId] : undefined,
  );
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({
      top: outputRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [active?.entries.length, active?.running]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [active?.id]);

  if (!active) return null;

  return (
    <section className="shrink-0 border-t border-white/5 bg-bg-soft" style={{ height }}>
      <header className="flex h-9 items-center gap-1 border-b border-white/5 bg-bg-panel/60 px-2">
        <TerminalSquare className="mx-1 h-3.5 w-3.5 text-accent" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onActivate(session.id)}
              className={clsx(
                'group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded px-2 text-[11px]',
                session.id === active.id
                  ? 'bg-bg text-text shadow-sm ring-1 ring-white/10'
                  : 'text-text-muted hover:bg-white/5 hover:text-text',
              )}
              title={`${session.title} · ${session.cwd ?? 'workspace root'}`}
            >
              <span className="truncate">{session.title}</span>
              {session.running ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.id);
                }}
                className="rounded p-0.5 opacity-50 hover:bg-white/10 hover:opacity-100"
                title="Close terminal"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={onAdd}
          className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="New PowerShell terminal"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onClear(active.id)}
          className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="Clear terminal"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onCollapse}
          className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="Collapse terminal"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </header>
      <div
        className="h-[calc(100%-36px)] bg-bg font-mono text-[12px] leading-normal"
        onClick={() => inputRef.current?.focus()}
      >
        <div ref={outputRef} className="h-full overflow-auto px-5 py-4">
          {active.entries.length === 0 ? (
            <div className="mb-4 whitespace-pre-wrap text-text-muted">
              Windows PowerShell{'\n'}
              Project workspace shell. Commands run inside this conversation workspace.
            </div>
          ) : null}
          {active.entries.map((entry) => (
            <TerminalEntryRow key={entry.id} entry={entry} />
          ))}
          {active.running ? (
            <div className="mt-1 text-accent">Running...</div>
          ) : null}

          {agentRuns && agentRuns.length > 0 ? (
            <div className="mt-3 border-t border-white/5 pt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted/70">
                🤖 Agent 执行的命令（只读）
              </div>
              {agentRuns.map((r) => (
                <div key={r.id} className="mb-2">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-amber-400/80">
                      {r.agentName} ❯
                    </span>
                    <span className="min-w-0 break-all text-text">{r.command}</span>
                  </div>
                  {r.stdout ? (
                    <pre className="whitespace-pre-wrap text-text-muted">{r.stdout}</pre>
                  ) : null}
                  {r.stderr ? (
                    <pre className="whitespace-pre-wrap text-rose-300/90">{r.stderr}</pre>
                  ) : null}
                  <div className="text-[10px] text-text-muted/60">
                    {r.timedOut
                      ? '⏱️ timed out'
                      : `exit ${r.exitCode ?? '?'}`}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-1 flex items-baseline gap-2">
            <span className="shrink-0 text-accent">{formatTerminalPrompt(active.cwd)}</span>
            <input
              ref={inputRef}
              value={active.input}
              disabled={active.running}
              onChange={(e) => onInput(active.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void onRun(active.id);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  onHistory(active.id, 'prev');
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  onHistory(active.id, 'next');
                } else if (e.key.toLowerCase() === 'l' && e.ctrlKey) {
                  e.preventDefault();
                  onClear(active.id);
                }
              }}
              className="min-w-0 flex-1 bg-transparent p-0 text-text caret-accent outline-none disabled:opacity-50"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function TerminalEntryRow({ entry }: { entry: TerminalEntry }) {
  if (entry.kind === 'command') {
    return (
      <div className="mt-1 whitespace-pre">
        <span className="text-accent">{entry.prompt}</span>
        <span className="text-text"> {entry.command}</span>
      </div>
    );
  }

  if (entry.kind === 'system') {
    return <div className="mt-1 whitespace-pre-wrap text-rose-300">{entry.text}</div>;
  }

  const hasOutput = Boolean(entry.stdout || entry.stderr);
  return (
    <div className="whitespace-pre">
      {entry.stdout ? <div className="overflow-x-auto py-0.5 text-text-muted">{entry.stdout}</div> : null}
      {entry.stderr ? <div className="overflow-x-auto py-0.5 text-rose-300">{entry.stderr}</div> : null}
      {entry.timedOut ? <div className="text-amber-400">Process timed out.</div> : null}
      {entry.truncated ? <div className="text-amber-400">Output truncated.</div> : null}
      {!hasOutput && entry.exitCode && entry.exitCode !== 0 ? (
        <div className="text-rose-300">exit {entry.exitCode}</div>
      ) : null}
    </div>
  );
}

function createTerminalSession(index: number): TerminalSession {
  return {
    id: `terminal-${index}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: `PowerShell ${index}`,
    cwd: null,
    input: '',
    running: false,
    history: [],
    historyIndex: null,
    entries: [],
  };
}

function formatTerminalPrompt(cwd: string | null): string {
  return `PS ${formatTerminalPath(cwd)}>`;
}

function formatTerminalPath(cwd: string | null): string {
  if (!cwd) return 'workspace';
  const normalized = cwd.replace(/\\/g, '/');
  const marker = '.agenthub-workspaces/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    const afterMarker = normalized.slice(markerIndex + marker.length);
    const [, ...workspaceParts] = afterMarker.split('/').filter(Boolean);
    return workspaceParts.length > 0 ? `workspace/${workspaceParts.join('/')}` : 'workspace';
  }
  if (normalized.length <= 48) return cwd;
  return `...${cwd.slice(-45)}`;
}

function ProjectTab({
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
        'flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs',
        active ? 'bg-white/10 text-text' : 'text-text-muted hover:bg-white/5 hover:text-text',
      )}
    >
      {icon}
      {children}
      {badge !== undefined ? (
        <span className="rounded bg-accent/25 px-1 text-[9px] font-semibold text-accent">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <button
      onMouseDown={onMouseDown}
      className="z-10 w-1 shrink-0 cursor-col-resize bg-white/[0.03] transition hover:bg-accent/40"
      aria-label="resize panel"
    />
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-white/10 p-4 text-center text-xs leading-relaxed text-text-muted">
      {text}
    </div>
  );
}

function buildWorkspaceTree(entries: WorkspaceFileEntry[]): WorkspaceTreeNode[] {
  interface MutableNode extends WorkspaceTreeNode {
    childMap: Map<string, MutableNode>;
  }

  const root: MutableNode = {
    name: '',
    path: '',
    type: 'directory',
    children: [],
    childMap: new Map(),
  };

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const path = parts.slice(0, i + 1).join('/');
      const isLast = i === parts.length - 1;
      const type = isLast ? entry.type : 'directory';
      let child = current.childMap.get(name);

      if (!child) {
        child = {
          name,
          path,
          type,
          size: isLast ? entry.size : undefined,
          mtime: isLast ? entry.mtime : undefined,
          children: [],
          childMap: new Map(),
        };
        current.childMap.set(name, child);
      } else if (isLast) {
        child.type = entry.type;
        child.size = entry.size;
        child.mtime = entry.mtime;
      }

      current = child;
    }
  }

  const toNode = (node: MutableNode): WorkspaceTreeNode => {
    const children = [...node.childMap.values()]
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(toNode);
    return {
      name: node.name,
      path: node.path,
      type: node.type,
      size: node.size,
      mtime: node.mtime,
      children,
    };
  };

  return [...root.childMap.values()]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map(toNode);
}

function iconForFile(name: string) {
  const ext = extensionOf(name);
  if (name === 'package.json' || name.endsWith('.lock')) return Package;
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) return FileCode2;
  if (['json', 'jsonc'].includes(ext)) return Braces;
  if (['md', 'mdx', 'txt', 'log'].includes(ext)) return FileText;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return Image;
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return FileText;
  if (['lock', 'yaml', 'yml', 'toml', 'ini', 'env'].includes(ext) || isConfigFile(name)) return Settings;
  return File;
}

function iconColorForFile(name: string, isDirectory: boolean): string {
  if (isDirectory) return 'text-amber-300';
  const ext = extensionOf(name);
  if (['ts', 'tsx'].includes(ext)) return 'text-sky-300';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'text-yellow-300';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'text-pink-300';
  if (['html', 'htm'].includes(ext)) return 'text-orange-300';
  if (['json', 'jsonc'].includes(ext)) return 'text-emerald-300';
  if (['md', 'mdx'].includes(ext)) return 'text-cyan-300';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return 'text-lime-300';
  if (isConfigFile(name)) return 'text-slate-300';
  return 'text-text-muted';
}

function languageForFile(name: string): string {
  const ext = extensionOf(name);
  if (['ts', 'tsx'].includes(ext)) return 'typescript';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'css';
  if (['json', 'jsonc'].includes(ext)) return 'json';
  if (['md', 'mdx'].includes(ext)) return 'markdown';
  if (['yaml', 'yml'].includes(ext)) return 'yaml';
  if (['xml', 'svg'].includes(ext)) return 'xml';
  if (['sh', 'bash', 'zsh', 'ps1'].includes(ext)) return 'shell';
  if (['py'].includes(ext)) return 'python';
  if (['java'].includes(ext)) return 'java';
  if (['go'].includes(ext)) return 'go';
  if (['rs'].includes(ext)) return 'rust';
  return 'plaintext';
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.lock')) return 'lock';
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx + 1) : '';
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const BINARY_EXT = new Set([
  ...IMAGE_EXT,
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'bin', 'wasm',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov', 'avi',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'sketch', 'class', 'jar',
]);

function isImageName(name: string): boolean {
  return IMAGE_EXT.has(extensionOf(name));
}
function isBinaryName(name: string): boolean {
  return BINARY_EXT.has(extensionOf(name));
}
function mimeForName(name: string): string {
  const e = extensionOf(name);
  if (e === 'svg') return 'image/svg+xml';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (IMAGE_EXT.has(e)) return `image/${e}`;
  if (e === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function isConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('.') ||
    lower.includes('config') ||
    lower === 'dockerfile' ||
    lower === 'makefile' ||
    lower === 'tsconfig.json' ||
    lower === 'vite.config.ts' ||
    lower === 'next.config.ts'
  );
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  const hostname = window.location.hostname.includes(':')
    ? `[${window.location.hostname}]`
    : window.location.hostname;
  return `${window.location.protocol}//${hostname}:4000${path}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
