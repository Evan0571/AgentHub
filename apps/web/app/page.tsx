import { ClientOnly } from '@/components/ClientOnly';
import { IdeShell } from '@/components/chat/IdeShell';

export default function Page() {
  // Entire shell is client-only — prevents any SSR HTML for browser extensions
  // (Cursor, Grammarly, dark-reader, ...) to tamper with before hydration.
  return (
    <ClientOnly>
      <IdeShell />
    </ClientOnly>
  );
}
