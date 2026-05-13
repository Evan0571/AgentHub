'use client';

import { useState } from 'react';
import { Check, Copy, FileCode2 } from 'lucide-react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
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
}

export function CodeCard({ code, lang, filePath }: CodeCardProps) {
  const isDiff = (lang ?? '').toLowerCase() === 'diff' || looksLikeUnifiedDiff(code);
  const displayLang = (lang || 'text').toLowerCase();

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-lg border border-white/10 bg-bg-soft/60">
      <CardHeader code={code} lang={displayLang} filePath={filePath} isDiff={isDiff} />
      {isDiff ? <DiffBody code={code} /> : <CodeBody code={code} lang={displayLang} />}
    </div>
  );
}

function CardHeader({
  code,
  lang,
  filePath,
  isDiff,
}: {
  code: string;
  lang: string;
  filePath?: string;
  isDiff: boolean;
}) {
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
      <button
        onClick={onCopy}
        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-text-muted hover:bg-white/5 hover:text-text"
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
  return (
    <div className="max-h-[60vh] overflow-auto">
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        showLineNumbers
        wrapLongLines={false}
        customStyle={{
          margin: 0,
          padding: '0.75rem 1rem',
          background: 'transparent',
          fontSize: '0.78rem',
          lineHeight: 1.55,
        }}
        codeTagProps={{ style: { fontFamily: 'inherit' } }}
        lineNumberStyle={{ color: '#475569', minWidth: '2em', paddingRight: '1em' }}
      >
        {code.replace(/\n$/, '')}
      </SyntaxHighlighter>
    </div>
  );
}

function DiffBody({ code }: { code: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <div className="max-h-[60vh] overflow-auto font-mono text-[0.78rem] leading-relaxed">
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
