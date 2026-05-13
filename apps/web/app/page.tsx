import { ClientOnly } from '@/components/ClientOnly';
import { Sidebar } from '@/components/chat/Sidebar';
import { ChatPane } from '@/components/chat/ChatPane';
import { RightPanel } from '@/components/chat/RightPanel';

export default function Page() {
  // Entire shell is client-only — prevents any SSR HTML for browser extensions
  // (Cursor, Grammarly, dark-reader, ...) to tamper with before hydration.
  return (
    <ClientOnly>
      <div className="flex h-screen w-screen overflow-hidden">
        <Sidebar />
        <ChatPane />
        <RightPanel />
      </div>
    </ClientOnly>
  );
}
