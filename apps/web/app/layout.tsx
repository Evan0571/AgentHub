import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'AgentHub',
  description: 'IM-style multi-Agent collaboration platform',
};

/**
 * Pre-hydration script: sets `.light` / `.dark` on <html> BEFORE React paints
 * so users never see a flash of the wrong palette. Reads localStorage; falls
 * back to dark (current default). Inlined so it's blocking and synchronous.
 */
const themeBootScript = `
(function(){try{var t=localStorage.getItem('agenthub-theme');var d=document.documentElement;if(t==='light'){d.classList.add('light');d.classList.remove('dark');}else{d.classList.add('dark');d.classList.remove('light');}}catch(e){document.documentElement.classList.add('dark');}})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
