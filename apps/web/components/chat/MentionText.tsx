'use client';

import { Fragment, useMemo } from 'react';
import { useConversationStore } from '@/lib/store';

/**
 * Render plain text and turn @agent-id substrings into colored chips
 * matching the conversation's member palette.
 */
export function MentionText({
  text,
  conversationId,
}: {
  text: string;
  conversationId: string;
}) {
  const members = useConversationStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.members,
  );

  const memberMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const m of members ?? []) map.set(m.agentId, { name: m.name, color: m.avatarColor });
    return map;
  }, [members]);

  const segments = useMemo(() => {
    const out: Array<{ kind: 'text' | 'mention'; value: string; id?: string }> = [];
    const re = /@([\w-]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = m[1]!;
      // Only treat as mention if it matches a known member id.
      if (!memberMap.has(id)) continue;
      if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
      out.push({ kind: 'mention', value: id, id });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
    if (out.length === 0) out.push({ kind: 'text', value: text });
    return out;
  }, [text, memberMap]);

  return (
    <span className="whitespace-pre-wrap text-sm leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <Fragment key={i}>{seg.value}</Fragment>;
        const info = memberMap.get(seg.id!)!;
        return (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center gap-1 rounded border border-white/10 bg-white/10 px-1.5 py-0.5 text-[12px] font-medium text-white/95"
          >
            <span className="h-3 w-0.5 rounded-full" style={{ background: info.color }} />
            @{info.name}
          </span>
        );
      })}
    </span>
  );
}
