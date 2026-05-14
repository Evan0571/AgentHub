'use client';

import { AlertTriangle, Info, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useConversationStore } from '@/lib/store';

/**
 * Global transient banner — shown at the top of the chat area for things
 * like Plan version conflicts that need user attention but shouldn't block
 * the rest of the UI.
 */
export function Banner() {
  const banner = useConversationStore((s) => s.banner);
  const dismiss = useConversationStore((s) => s.dismissBanner);
  if (!banner) return null;

  const Icon = banner.kind === 'error' ? XCircle : banner.kind === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={clsx(
        'flex items-start gap-2 border-b px-4 py-2 text-xs',
        banner.kind === 'error'
          ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          : banner.kind === 'warn'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-accent/30 bg-accent/10 text-accent',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{banner.text}</span>
      <button
        onClick={dismiss}
        className="rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
        aria-label="dismiss"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
