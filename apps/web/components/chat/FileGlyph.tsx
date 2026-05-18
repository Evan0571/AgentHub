'use client';

import { Braces, Database, File, FileCode2, FileText, Folder, Image, Package, Palette, Settings, TerminalSquare } from 'lucide-react';
import clsx from 'clsx';

type FileGlyphType = 'file' | 'directory';
type FileGlyphSize = 'sm' | 'md';

interface FileGlyphProps {
  name: string;
  type: FileGlyphType;
  open?: boolean;
  size?: FileGlyphSize;
  className?: string;
}

interface GlyphStyle {
  icon: typeof File;
  label?: string;
  className: string;
  fill?: boolean;
}

const SIZE_CLASS: Record<FileGlyphSize, string> = {
  sm: 'h-5 w-5 text-[8.5px]',
  md: 'h-6 w-6 text-[9px]',
};

export function FileGlyph({ name, type, open, size = 'sm', className }: FileGlyphProps) {
  const style = type === 'directory' ? directoryStyle(open) : fileStyle(name);
  const Icon = style.icon;

  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-[5px] border font-bold leading-none shadow-sm ring-1 ring-inset',
        SIZE_CLASS[size],
        style.className,
        className,
      )}
      title={name}
    >
      {style.label ? (
        <span className="font-mono font-black">{style.label}</span>
      ) : (
        <Icon className={clsx(size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5', style.fill && 'fill-current')} />
      )}
    </span>
  );
}

function directoryStyle(open?: boolean): GlyphStyle {
  return {
    icon: Folder,
    className: open
      ? 'border-amber-500/50 bg-amber-400/25 text-amber-600 ring-amber-500/20 dark:text-amber-300'
      : 'border-amber-500/40 bg-amber-500/20 text-amber-700 ring-amber-500/20 dark:text-amber-300',
    fill: true,
  };
}

function fileStyle(name: string): GlyphStyle {
  const lower = name.toLowerCase();
  const ext = extensionOf(lower);

  if (lower === 'package.json') {
    return tone(Package, 'border-red-500/40 bg-red-500/20 text-red-700 ring-red-500/20 dark:text-red-300');
  }
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile') || lower === 'docker-compose.yml' || lower === 'docker-compose.yaml') {
    return tone(Database, 'border-cyan-500/40 bg-cyan-500/20 text-cyan-800 ring-cyan-500/20 dark:text-cyan-300');
  }
  if (lower.startsWith('.env') || lower.includes('config') || isConfigFile(lower)) {
    return tone(Settings, 'border-slate-500/40 bg-slate-500/20 text-slate-700 ring-slate-500/20 dark:text-slate-300');
  }
  if (['ts', 'tsx'].includes(ext)) {
    return labeled(ext === 'tsx' ? 'TSX' : 'TS', 'border-sky-500/40 bg-sky-500/20 text-sky-800 ring-sky-500/20 dark:text-sky-300');
  }
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return labeled(ext === 'jsx' ? 'JSX' : 'JS', 'border-yellow-500/50 bg-yellow-400/25 text-yellow-800 ring-yellow-500/20 dark:text-yellow-300');
  }
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return tone(Palette, 'border-pink-500/40 bg-pink-500/20 text-pink-800 ring-pink-500/20 dark:text-pink-300');
  }
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) {
    return labeled(ext === 'html' || ext === 'htm' ? 'HT' : ext.toUpperCase().slice(0, 3), 'border-orange-500/40 bg-orange-500/20 text-orange-800 ring-orange-500/20 dark:text-orange-300');
  }
  if (['json', 'jsonc'].includes(ext) || lower.endsWith('.lock')) {
    return tone(Braces, 'border-emerald-500/40 bg-emerald-500/20 text-emerald-800 ring-emerald-500/20 dark:text-emerald-300');
  }
  if (['md', 'mdx', 'txt', 'log'].includes(ext)) {
    return tone(FileText, 'border-blue-500/40 bg-blue-500/20 text-blue-800 ring-blue-500/20 dark:text-blue-300');
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) {
    return tone(Image, 'border-lime-500/40 bg-lime-500/20 text-lime-800 ring-lime-500/20 dark:text-lime-300');
  }
  if (['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'].includes(ext)) {
    return tone(TerminalSquare, 'border-violet-500/40 bg-violet-500/20 text-violet-800 ring-violet-500/20 dark:text-violet-300');
  }
  if (['sql', 'db', 'sqlite'].includes(ext)) {
    return tone(Database, 'border-teal-500/40 bg-teal-500/20 text-teal-800 ring-teal-500/20 dark:text-teal-300');
  }
  if (['py', 'java', 'go', 'rs', 'c', 'cpp', 'h'].includes(ext)) {
    return tone(FileCode2, 'border-indigo-500/40 bg-indigo-500/20 text-indigo-800 ring-indigo-500/20 dark:text-indigo-300');
  }
  return tone(File, 'border-slate-400/40 bg-slate-500/20 text-slate-700 ring-slate-500/20 dark:text-slate-300');
}

function tone(icon: typeof File, className: string): GlyphStyle {
  return { icon, className };
}

function labeled(label: string, className: string): GlyphStyle {
  return { icon: File, label, className };
}

function extensionOf(name: string): string {
  if (name.endsWith('.lock')) return 'lock';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : '';
}

function isConfigFile(name: string): boolean {
  return (
    name === 'makefile' ||
    name === 'tsconfig.json' ||
    name === 'vite.config.ts' ||
    name === 'next.config.ts' ||
    name === 'tailwind.config.ts' ||
    name === 'postcss.config.mjs'
  );
}
