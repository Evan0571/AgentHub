'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, AtSign, Download, FileText, Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import type { MessageAttachment } from '@agenthub/shared-types';
import { MessageList } from './MessageList';
import { baseRoleIdFromConvAgent, isHiddenSystemAgentId, prettyAgentName, useConversationStore } from '@/lib/store';
import { MentionPicker, type MentionCandidate } from './MentionPicker';
import { Banner } from '../Banner';
import { MembersPanel } from './MembersPanel';

interface MentionState {
  /** Index of the '@' that opened the picker. */
  triggerIdx: number;
  /** Substring after '@' up to the caret. Empty means just typed '@'. */
  query: string;
}

interface PendingAttachment extends MessageAttachment {
  previewUrl?: string;
}

export function ChatPane() {
  const active = useConversationStore((s) =>
    s.conversations.find((c) => c.id === s.activeId),
  );
  const sendUserMessage = useConversationStore((s) => s.sendUserMessage);
  const hydrate = useConversationStore((s) => s.hydrate);
  const allMessages = useConversationStore((s) =>
    s.activeId ? s.messagesByConv[s.activeId] : undefined,
  );
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [active?.id]);

  // Reset on conversation switch.
  useEffect(() => {
    attachments.forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    });
    setAttachments([]);
    setUploadError(null);
    setText('');
    setMention(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // Fetch persisted history on mount + whenever the active conversation
  // changes (idempotent; the store dedupes via hydratedConvs).
  useEffect(() => {
    if (active?.id) void hydrate(active.id);
  }, [active?.id, hydrate]);

  // Auto-grow the composer up to a max height so long / multi-line text is
  // readable. MUST stay above the early `return` below — it's a hook.
  const autoGrow = () => {
    const ta = inputRef.current;
    if (!ta) return;
    // Canonical reliable autosize: collapse to 0 so scrollHeight reflects the
    // TRUE content height (not a stale / flex-stretched value), read it
    // synchronously (forces reflow), then set. No rAF, no 'auto' — that
    // combo is what produced the stuck tall/empty box.
    ta.style.height = '0px';
    const next = Math.min(Math.max(ta.scrollHeight, 36), 240);
    ta.style.height = next + 'px';
  };
  useEffect(autoGrow, [text]);

  const candidates: MentionCandidate[] = useMemo(() => {
    if (!active) return [];
    return active.members.filter((m) => !isHiddenSystemAgentId(m.agentId)).map((m) => ({
      id: m.agentId,
      name: prettyAgentName(m.agentId, m.name),
      color: m.avatarColor,
      hint: describe(m.adapterId),
    }));
  }, [active]);
  const visibleMembers = useMemo(
    () => active?.members.filter((m) => !isHiddenSystemAgentId(m.agentId)) ?? [],
    [active],
  );
  const visibleDefaultAgentId =
    active?.targetAgentId && !isHiddenSystemAgentId(active.targetAgentId)
      ? active.targetAgentId
      : visibleMembers[0]?.agentId;

  if (!active) {
    return (
      <main className="flex flex-1 items-center justify-center text-text-muted">
        选择或新建一个会话开始协作
      </main>
    );
  }

  /** Inspect the textarea before caret to decide whether to (re)open the picker. */
  const recomputeMention = (newText: string, caret: number) => {
    const before = newText.slice(0, caret);
    // Find the last '@'. It must be at start-of-string, after whitespace, or after newline.
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) {
      setMention(null);
      return;
    }
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1]!)) {
      setMention(null);
      return;
    }
    const query = before.slice(atIdx + 1);
    // If query contains whitespace, the user has moved past the trigger.
    if (/\s/.test(query)) {
      setMention(null);
      return;
    }
    setMention({ triggerIdx: atIdx, query });
  };

  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    recomputeMention(value, e.target.selectionStart ?? value.length);
  };

  const onSelect = (c: MentionCandidate) => {
    if (!mention) return;
    const before = text.slice(0, mention.triggerIdx);
    const after = text.slice(mention.triggerIdx + 1 + mention.query.length);
    // Insert the short role token (e.g. @solution-architect) instead of the
    // raw conv-agent UUID; the store resolves it back to the real member id.
    const token = baseRoleIdFromConvAgent(c.id) ?? c.id;
    const inserted = `@${token} `;
    const next = before + inserted + after;
    setText(next);
    setMention(null);
    // Restore caret after the inserted chip.
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      const ta = inputRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  const onExportTranscript = () => {
    if (!active) return;
    const msgs = allMessages ?? [];
    const lines: string[] = [];
    lines.push(`# 会话导出：${active.title}`);
    lines.push('');
    lines.push(
      `- 类型：${active.type === 'group' ? '群聊' : '单聊'}　- 成员：${active.members
        .map((m) => `${m.name}(${m.adapterId})`)
        .join('，')}`,
    );
    lines.push(`- 导出时间：${new Date().toLocaleString()}　- 消息数：${msgs.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const m of msgs) {
      const ts = (() => {
        try {
          return new Date(m.createdAt).toLocaleTimeString();
        } catch {
          return m.createdAt;
        }
      })();
      lines.push(`## ${m.senderName} · ${m.senderType} · ${ts}`);
      lines.push('');
      if (m.thinking && m.thinking.trim()) {
        lines.push('<details><summary>思考过程 / 工具活动</summary>');
        lines.push('');
        lines.push('```');
        lines.push(m.thinking.trim());
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      lines.push(m.text && m.text.trim() ? m.text : '_(无正文)_');
      if (m.attachments && m.attachments.length > 0) {
        lines.push('');
        lines.push(
          `附件：${m.attachments.map((a) => `${a.name} (${a.kind}, ${a.size}B)`).join('；')}`,
        );
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = active.title.replace(/[^\w一-龥-]+/g, '_').slice(0, 40);
    a.href = url;
    a.download = `agenthub-${safe}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onSend = () => {
    if ((!text.trim() && attachments.length === 0) || uploading) return;
    const sentAttachments: MessageAttachment[] = attachments.map(({ previewUrl: _previewUrl, ...file }) => file);
    sendUserMessage(active.id, text, sentAttachments);
    attachments.forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    });
    setAttachments([]);
    setText('');
    setMention(null);
  };

  const onPickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void uploadFiles([...files]);
  };

  const uploadFiles = async (incoming: File[]) => {
    const files = incoming.filter(Boolean);
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await Promise.all(
        files.slice(0, 8).map(async (file) => {
          if (file.size > 10 * 1024 * 1024) {
            throw new Error(`${file.name} 超过 10MB`);
          }
          const base64 = await fileToDataUrl(file);
          const res = await fetch(
            apiUrl(`/api/conversations/${encodeURIComponent(active.id)}/workspace/upload`),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: file.name,
                mimeType: file.type || 'application/octet-stream',
                base64,
              }),
            },
          );
          if (!res.ok) throw new Error(await res.text());
          const saved = (await res.json()) as MessageAttachment;
          return {
            ...saved,
            previewUrl: saved.kind === 'image' ? URL.createObjectURL(file) : undefined,
          } satisfies PendingAttachment;
        }),
      );
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((file) => file.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((file) => file.id !== id);
    });
  };

  const openPickerManually = () => {
    const ta = inputRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? text.length;
    // Insert an '@' at caret if there isn't one already triggering.
    if (!text.slice(0, caret).endsWith('@')) {
      const next = text.slice(0, caret) + '@' + text.slice(caret);
      setText(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caret + 1, caret + 1);
        recomputeMention(next, caret + 1);
      });
    } else {
      recomputeMention(text, caret);
      ta.focus();
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragLeave = () => {
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    void uploadFiles([...e.dataTransfer.files]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    // Don't also paste the binary as garbage text.
    e.preventDefault();
    void uploadFiles(files);
  };

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col bg-bg"
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-accent/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-accent/60 bg-bg/80 px-6 py-4 text-center">
            <Paperclip className="mx-auto mb-1 h-5 w-5 text-accent" />
            <div className="text-sm font-medium text-text">松开上传到本会话</div>
            <div className="text-[11px] text-text-muted">图片 / 文本 / 代码 · 单个最大 10MB · 一次最多 8 个</div>
          </div>
        </div>
      ) : null}
      <Banner />
      <header
        onClick={() => setShowMembers(true)}
        className="flex cursor-pointer items-center gap-3 border-b border-white/5 px-5 py-3 hover:bg-white/[0.02]"
        title="点击查看 / 管理成员"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded bg-accent/20 text-accent font-semibold">
          {active.title[0]}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{active.title}</div>
          <div className="text-xs text-text-muted">
            {visibleMembers.length} 个成员 · {active.type === 'group' ? '群聊' : '单聊'}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onExportTranscript();
          }}
          className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text"
          title="导出本群完整对话（Markdown，发给我用）"
        >
          <Download className="h-4 w-4" />
        </button>
      </header>

      <MessageList conversationId={active.id} />

      <footer className="relative border-t border-white/5 px-4 py-3">
        {mention ? (
          <div className="absolute bottom-full left-4 right-4 mb-2">
            <MentionPicker
              candidates={candidates}
              query={mention.query}
              onSelect={onSelect}
              onCancel={() => setMention(null)}
            />
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.pdf"
          className="hidden"
          onChange={(e) => void onPickFiles(e.currentTarget.files)}
        />

        {attachments.length > 0 || uploadError ? (
          <div className="mb-2 rounded-lg border border-white/5 bg-white/[0.03] p-2">
            {attachments.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {attachments.map((file) => (
                  <AttachmentChip key={file.id} file={file} onRemove={() => removeAttachment(file.id)} />
                ))}
              </div>
            ) : null}
            {uploadError ? <div className="mt-1 text-[11px] text-rose-400">{uploadError}</div> : null}
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-lg bg-white/5 p-2">
          <button
            type="button"
            onClick={openPickerManually}
            className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
            title="@ 提及"
          >
            <AtSign className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text disabled:opacity-40"
            title="上传图片或文件"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
          <textarea
            ref={inputRef}
            value={text}
            onChange={onTextChange}
            onPaste={onPaste}
            onKeyUp={(e) => {
              // Re-evaluate on caret-only moves (arrow keys, mouse won't fire change).
              const ta = e.currentTarget;
              recomputeMention(ta.value, ta.selectionStart ?? ta.value.length);
            }}
            onKeyDown={(e) => {
              // Picker open: it handles Arrow/Enter/Tab/Esc. We must not also submit on Enter.
              if (mention) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder={
              active.type === 'group'
                ? '输入消息，@ 选择 Agent；Enter 发送 / Shift+Enter 换行'
                : '输入消息，Enter 发送 / Shift+Enter 换行'
            }
            className="max-h-[240px] min-h-[1.5rem] flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-relaxed outline-none placeholder:text-text-muted"
          />
          <button
            onClick={onSend}
            disabled={(!text.trim() && attachments.length === 0) || uploading}
            className="flex h-8 w-8 items-center justify-center rounded bg-accent text-white transition hover:bg-accent-hover disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1 px-1 text-[10px] text-text-muted/70">
          {active.type === 'group'
            ? `成员：${visibleMembers.map((m) => m.name).join('，')}`
            : `本会话默认 @${visibleDefaultAgentId ?? ''}`}
        </div>
      </footer>

      {showMembers ? (
        <MembersPanel conversation={active} onClose={() => setShowMembers(false)} />
      ) : null}
    </main>
  );
}

function AttachmentChip({
  file,
  onRemove,
}: {
  file: PendingAttachment;
  onRemove: () => void;
}) {
  const Icon = file.kind === 'image' ? ImageIcon : FileText;
  return (
    <div className="group flex max-w-[240px] items-center gap-2 rounded-md border border-white/5 bg-bg-soft/80 px-2 py-1.5">
      {file.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.previewUrl} alt="" className="h-8 w-8 rounded object-cover" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded bg-bg text-text-muted">
          <Icon className="h-4 w-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-text">{file.name}</span>
        <span className="block text-[10px] text-text-muted">{formatBytes(file.size)}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-text-muted hover:bg-white/5 hover:text-text"
        title="移除附件"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read file failed'));
    reader.readAsDataURL(file);
  });
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:4000${path}`;
  const hostname = window.location.hostname.includes(':')
    ? `[${window.location.hostname}]`
    : window.location.hostname;
  return `${window.location.protocol}//${hostname}:4000${path}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function describe(adapterId: string): string | undefined {
  if (adapterId === 'deepseek-v4-flash') return 'V4 Flash · 快 · 便宜 · 支持思考';
  if (adapterId === 'deepseek-v4-pro') return 'V4 Pro · 强推理 · 规划';
  if (adapterId === 'deepseek-v3') return 'V4 Flash · 旧标识';
  if (adapterId === 'deepseek-r1') return 'V4 Pro · 旧标识';
  if (adapterId === 'claude-code') return '代码 · 工具调用';
  if (adapterId === 'codex') return 'OpenAI · 代码沙箱';
  if (adapterId === 'doubao') return '中文 · 火山';
  if (adapterId === 'mock') return '本地回放 · 不烧 token';
  return undefined;
}
