'use client';

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'agenthub-theme';
const THEME_EVENT = 'agenthub-theme-change';

/**
 * Read the active theme from <html>'s class list. The class is set by the
 * pre-hydration script in layout.tsx so we never observe a wrong initial
 * value during SSR / first paint.
 */
function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private-mode / disabled storage — fine to ignore */
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => readTheme());

  useEffect(() => {
    const syncTheme = () => setThemeState(readTheme());
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) syncTheme();
    };
    const observer = new MutationObserver(syncTheme);

    syncTheme();
    window.addEventListener(THEME_EVENT, syncTheme);
    window.addEventListener('storage', onStorage);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      window.removeEventListener(THEME_EVENT, syncTheme);
      window.removeEventListener('storage', onStorage);
      observer.disconnect();
    };
  }, []);

  const setTheme = (t: Theme) => {
    applyTheme(t);
    setThemeState(t);
  };

  const toggle = () => setTheme(readTheme() === 'dark' ? 'light' : 'dark');

  return { theme, setTheme, toggle };
}
