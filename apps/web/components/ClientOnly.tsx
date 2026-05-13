'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Render children only after mount. Use it to wrap subtrees where browser
 * extensions (Cursor, Grammarly, dark-reader, ...) inject attributes or
 * classes that would otherwise cause Next.js hydration mismatches.
 */
export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Render nothing on SSR / pre-mount so browser-extension DOM tampering
  // cannot create hydration mismatches.
  if (!mounted) return null;
  return <>{children}</>;
}
