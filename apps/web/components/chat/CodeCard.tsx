'use client';

import { useState } from 'react';
import { Check, Copy, FileCode2, Play } from 'lucide-react';
import { useConversationStore } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { isRunnable } from '@/lib/preview-utils';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';

// Register only the languages we want to support — keeps the bundle small.
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('py', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('xml', markup);
SyntaxHighlighter.registerLanguage('vue', markup);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('rs', rust);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);

export interface CodeCardProps {
  code: string;
  /** Language tag from the fenced block, e.g. "typescript", "diff", "vue". */
  lang?: string;
  /** Optional file path extracted from the meta string (` ```ts path=src/a.ts `). */
  filePath?: string;
  /** Stable uid (`${msgId}#${blockIdx}`) for opening in Preview tab. */
  blockUid?: string;
}

export function CodeCard({ code, lang, filePath, blockUid }: CodeCardProps) {
  const isDiff = (lang ?? '').toLowerCase() === 'diff' || looksLikeUnifiedDiff(code);
  const displayLang = (lang || 'text').toLowerCase();

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-lg border border-white/10 bg-bg-soft/40">
      <CardHeader
        code={code}
        lang={displayLang}
        filePath={filePath}
        isDiff={isDiff}
        blockUid={blockUid}
      />
      {isDiff ? <DiffBody code={code} /> : <CodeBody code={code} lang={displayLang} />}
    </div>
  );
}

function CardHeader({
  code,
  lang,
  filePath,
  isDiff,
  blockUid,
}: {
  code: string;
  lang: string;
  filePath?: string;
  isDiff: boolean;
  blockUid?: string;
}) {
  const openPreview = useConversationStore((s) => s.openPreview);
  const runnable =
    !!blockUid && isRunnable({ uid: blockUid, fromMessageId: '', lang, path: filePath, code });
  // Only files that look like top-level entries become the preview entry on
  // click. For child components we just open the Preview tab and let the user
  // see the existing entry (avoids "props undefined" crashes).
  const isEntryLike = (() => {
    const base = filePath?.split(/[\\/]/).pop()?.replace(/\.(tsx?|jsx?|vue)$/i, '') ?? '';
    return ['App', 'Main', 'Index', 'Page', 'Root', 'main', 'index'].includes(base);
  })();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied */
    }
  };
  return (
    <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-3 py-1.5 text-xs">
      <FileCode2 className="h-3.5 w-3.5 text-text-muted" />
      {filePath ? (
        <span className="font-mono text-text">{filePath}</span>
      ) : (
        <span className="text-text-muted">{isDiff ? 'diff' : lang}</span>
      )}
      {filePath ? (
        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          {isDiff ? 'diff' : lang}
        </span>
      ) : null}
      {runnable && blockUid ? (
        <button
          onClick={() => openPreview(blockUid, { setEntry: isEntryLike })}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-emerald-300 hover:bg-emerald-500/10"
          title={isEntryLike ? '在右侧 Preview 中以本文件为入口运行' : '在右侧 Preview 中查看（入口仍为 App 类文件，点文件列表可显式切换入口）'}
        >
          <Play className="h-3 w-3 fill-current" />
          <span>运行</span>
        </button>
      ) : null}
      <button
        onClick={onCopy}
        className={
          (runnable ? '' : 'ml-auto ') +
          'flex items-center gap-1 rounded px-1.5 py-0.5 text-text-muted hover:bg-white/5 hover:text-text'
        }
        aria-label="copy"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-emerald-400" />
            <span className="text-emerald-400">已复制</span>
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" />
            <span>复制</span>
          </>
        )}
      </button>
    </div>
  );
}

function CodeBody({ code, lang }: { code: string; lang: string }) {
  const { theme } = useTheme();
  const codeTheme = theme === 'light' ? lightCodeTheme : darkCodeTheme;
  const lineNumberStyle = theme === 'light' ? lightLineNumberStyle : darkLineNumberStyle;

  return (
    <div className="max-h-[60vh] overflow-auto">
      <SyntaxHighlighter
        language={lang}
        style={codeTheme}
        showLineNumbers
        wrapLongLines={false}
        customStyle={{
          margin: 0,
          padding: '0.75rem 1rem',
          background: 'transparent',
          fontSize: '0.78rem',
          fontWeight: 500,
          lineHeight: 1.55,
          textShadow: 'none',
        }}
        codeTagProps={{ style: { fontFamily: 'inherit', fontWeight: 500, textShadow: 'none' } }}
        lineNumberStyle={lineNumberStyle}
      >
        {code.replace(/\n$/, '')}
      </SyntaxHighlighter>
    </div>
  );
}

function DiffBody({ code }: { code: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <div className="max-h-[60vh] overflow-auto font-mono text-[0.78rem] font-medium leading-relaxed">
      {lines.map((line, i) => {
        let className = 'px-3 py-0.5 whitespace-pre';
        if (line.startsWith('+++') || line.startsWith('---')) {
          className += ' bg-white/5 text-text-muted';
        } else if (line.startsWith('@@')) {
          className += ' bg-accent/10 text-accent';
        } else if (line.startsWith('+')) {
          className += ' bg-emerald-500/10 text-emerald-300';
        } else if (line.startsWith('-')) {
          className += ' bg-rose-500/10 text-rose-300';
        } else {
          className += ' text-text-muted';
        }
        return (
          <div key={i} className={className}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

function looksLikeUnifiedDiff(code: string): boolean {
  return /^@@\s.*@@/m.test(code) && /^[-+]/m.test(code);
}

const lightLineNumberStyle = {
  color: 'rgb(148 163 184)',
  minWidth: '2em',
  paddingRight: '1em',
  textShadow: 'none',
} as const;

const darkLineNumberStyle = {
  color: 'rgb(100 116 139)',
  minWidth: '2em',
  paddingRight: '1em',
  textShadow: 'none',
} as const;

const lightCodeTheme = {
  'code[class*="language-"]': {
    color: 'rgb(71 85 105)',
    background: 'transparent',
    textShadow: 'none',
    fontFamily: 'inherit',
  },
  'pre[class*="language-"]': {
    color: 'rgb(71 85 105)',
    background: 'transparent',
    textShadow: 'none',
  },
  comment: { color: 'rgb(148 163 184)', fontStyle: 'italic' },
  prolog: { color: 'rgb(148 163 184)' },
  doctype: { color: 'rgb(148 163 184)' },
  cdata: { color: 'rgb(148 163 184)' },
  punctuation: { color: 'rgb(100 116 139)' },
  property: { color: 'rgb(15 118 110)' },
  tag: { color: 'rgb(15 118 110)' },
  boolean: { color: 'rgb(180 83 9)' },
  number: { color: 'rgb(180 83 9)' },
  constant: { color: 'rgb(180 83 9)' },
  symbol: { color: 'rgb(180 83 9)' },
  deleted: { color: 'rgb(190 18 60)' },
  selector: { color: 'rgb(14 116 144)' },
  attrName: { color: 'rgb(14 116 144)' },
  string: { color: 'rgb(21 128 61)' },
  char: { color: 'rgb(21 128 61)' },
  builtin: { color: 'rgb(21 128 61)' },
  inserted: { color: 'rgb(21 128 61)' },
  operator: { color: 'rgb(71 85 105)' },
  entity: { color: 'rgb(71 85 105)' },
  url: { color: 'rgb(14 116 144)' },
  atrule: { color: 'rgb(15 118 110)' },
  attrValue: { color: 'rgb(21 128 61)' },
  keyword: { color: 'rgb(15 118 110)', fontWeight: 600 },
  function: { color: 'rgb(37 99 235)' },
  className: { color: 'rgb(180 83 9)' },
  regex: { color: 'rgb(21 128 61)' },
  important: { color: 'rgb(190 18 60)', fontWeight: 600 },
  variable: { color: 'rgb(71 85 105)' },
} as const;

const darkCodeTheme = {
  'code[class*="language-"]': {
    color: 'rgb(226 232 240)',
    background: 'transparent',
    textShadow: 'none',
    fontFamily: 'inherit',
  },
  'pre[class*="language-"]': {
    color: 'rgb(226 232 240)',
    background: 'transparent',
    textShadow: 'none',
  },
  comment: { color: 'rgb(100 116 139)', fontStyle: 'italic' },
  prolog: { color: 'rgb(100 116 139)' },
  doctype: { color: 'rgb(100 116 139)' },
  cdata: { color: 'rgb(100 116 139)' },
  punctuation: { color: 'rgb(203 213 225)' },
  property: { color: 'rgb(45 212 191)' },
  tag: { color: 'rgb(45 212 191)' },
  boolean: { color: 'rgb(251 191 36)' },
  number: { color: 'rgb(251 191 36)' },
  constant: { color: 'rgb(251 191 36)' },
  symbol: { color: 'rgb(251 191 36)' },
  deleted: { color: 'rgb(251 113 133)' },
  selector: { color: 'rgb(56 189 248)' },
  attrName: { color: 'rgb(56 189 248)' },
  string: { color: 'rgb(52 211 153)' },
  char: { color: 'rgb(52 211 153)' },
  builtin: { color: 'rgb(52 211 153)' },
  inserted: { color: 'rgb(52 211 153)' },
  operator: { color: 'rgb(203 213 225)' },
  entity: { color: 'rgb(203 213 225)' },
  url: { color: 'rgb(56 189 248)' },
  atrule: { color: 'rgb(45 212 191)' },
  attrValue: { color: 'rgb(52 211 153)' },
  keyword: { color: 'rgb(45 212 191)', fontWeight: 600 },
  function: { color: 'rgb(96 165 250)' },
  className: { color: 'rgb(251 191 36)' },
  regex: { color: 'rgb(52 211 153)' },
  important: { color: 'rgb(251 113 133)', fontWeight: 600 },
  variable: { color: 'rgb(226 232 240)' },
} as const;
