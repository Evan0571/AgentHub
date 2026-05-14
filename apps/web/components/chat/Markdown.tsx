'use client';

import { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeCard } from './CodeCard';

/**
 * Chat-tuned Markdown renderer.
 * Streaming-safe: incomplete markdown (un-closed ``` etc) renders as best-effort
 * without crashing.
 *
 * `messageId` enables the CodeCard's "Run in Preview" affordance by computing
 * a stable block uid that matches `extractCodeBlocks()` output.
 */
export function Markdown({ text, messageId }: { text: string; messageId?: string }) {
  const counterRef = useRef(0);
  // Reset the per-render counter when content changes so block #0 always
  // refers to the first fenced block in source order.
  useMemo(() => {
    counterRef.current = 0;
  }, [text]);
  return (
    <div className="agenthub-md text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href, ...props }) => (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              {children}
            </a>
          ),
          code(props) {
            const { children, className, node } = props as {
              children?: React.ReactNode;
              className?: string;
              node?: { data?: { meta?: string } };
            };
            const langMatch = /language-([\w-]+)/.exec(className ?? '');

            // Inline `code`
            if (!langMatch) {
              return (
                <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em] text-accent">
                  {children}
                </code>
              );
            }

            // Fenced ```lang  block. Extract meta like `path=src/Foo.tsx`.
            const lang = langMatch[1];
            const meta = node?.data?.meta ?? '';
            const pathMatch = /(?:^|\s)path=([^\s]+)/.exec(meta);
            const codeText = Array.isArray(children)
              ? children.join('')
              : String(children ?? '');
            const blockIdx = counterRef.current++;
            const blockUid = messageId ? `${messageId}#${blockIdx}` : undefined;

            return (
              <CodeCard
                code={codeText}
                lang={lang}
                filePath={pathMatch?.[1]}
                blockUid={blockUid}
              />
            );
          },
          // We render the card ourselves; let `pre` be a transparent passthrough.
          pre: ({ children }) => <>{children}</>,
          table: ({ children, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th
              {...props}
              className="border-b border-white/10 px-2 py-1 text-left font-semibold text-text"
            >
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="border-b border-white/5 px-2 py-1 align-top">
              {children}
            </td>
          ),
          ul: ({ children, ...props }) => (
            <ul {...props} className="my-1 list-disc space-y-0.5 pl-5">
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol {...props} className="my-1 list-decimal space-y-0.5 pl-5">
              {children}
            </ol>
          ),
          p: ({ children, ...props }) => (
            <p {...props} className="my-1 first:mt-0 last:mb-0">
              {children}
            </p>
          ),
          h1: ({ children, ...props }) => (
            <h1 {...props} className="mt-2 mb-1 text-base font-semibold">
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 {...props} className="mt-2 mb-1 text-sm font-semibold">
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 {...props} className="mt-2 mb-1 text-sm font-semibold">
              {children}
            </h3>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              {...props}
              className="my-1 border-l-2 border-white/10 pl-3 text-text-muted"
            >
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-white/5" />,
          strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
