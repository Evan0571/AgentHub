'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AtSign } from 'lucide-react';

export interface MentionCandidate {
  id: string;
  name: string;
  color: string;
  hint?: string;
}

export interface MentionPickerProps {
  candidates: MentionCandidate[];
  query: string;
  onSelect: (c: MentionCandidate) => void;
  onCancel: () => void;
}

export function MentionPicker({ candidates, query, onSelect, onCancel }: MentionPickerProps) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [query, candidates.length]);

  // Capture keyboard nav at window level so the textarea doesn't eat the events.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (filtered.length === 0) {
        if (e.key === 'Escape') {
          onCancel();
          e.preventDefault();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          setActive((a) => (a + 1) % filtered.length);
          e.preventDefault();
          break;
        case 'ArrowUp':
          setActive((a) => (a - 1 + filtered.length) % filtered.length);
          e.preventDefault();
          break;
        case 'Enter':
        case 'Tab': {
          const chosen = filtered[active];
          if (chosen) {
            onSelect(chosen);
            e.preventDefault();
          }
          break;
        }
        case 'Escape':
          onCancel();
          e.preventDefault();
          break;
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [filtered, active, onSelect, onCancel]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (filtered.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-bg-panel/95 px-3 py-2 text-xs text-text-muted shadow-xl backdrop-blur">
        没有匹配的 Agent — 按 Esc 取消
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-64 w-72 overflow-y-auto rounded-lg border border-white/10 bg-bg-panel/95 py-1 shadow-xl backdrop-blur"
    >
      <div className="flex items-center gap-1 px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
        <AtSign className="h-3 w-3" />
        提及 Agent
      </div>
      {filtered.map((c, i) => (
        <button
          key={c.id}
          data-idx={i}
          onMouseEnter={() => setActive(i)}
          onClick={() => onSelect(c)}
          className={clsx(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
            i === active ? 'bg-accent/20 text-text' : 'hover:bg-white/5',
          )}
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
            style={{ background: c.color }}
          >
            {c.name[0]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{c.name}</span>
            {c.hint ? (
              <span className="block truncate text-[11px] text-text-muted">{c.hint}</span>
            ) : null}
          </span>
          <span className="font-mono text-[10px] text-text-muted">@{c.id}</span>
        </button>
      ))}
    </div>
  );
}
