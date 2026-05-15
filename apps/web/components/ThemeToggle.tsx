'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/theme';

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isLight = theme === 'light';
  return (
    <button
      onClick={toggle}
      className={
        'rounded p-1 text-text-muted hover:bg-white/5 hover:text-text ' + (className ?? '')
      }
      title={isLight ? '切到深色' : '切到浅色'}
      aria-label="toggle theme"
    >
      {isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}
