/**
 * Multi-file project preview engine.
 *
 * How it works at iframe runtime:
 *   1. For every code block we ship the raw source as JSON.
 *   2. Babel-standalone (already loaded) transforms each file (TS/JSX) into
 *      plain ESM JS *with import statements intact*.
 *   3. Each transformed file is wrapped in a Blob and registered as an object
 *      URL in a dynamic <script type="importmap">. This lets the entry file
 *      do `import X from './X'` and have it resolve to the right blob.
 *   4. `react`, `react-dom/client` etc. are mapped to esm.sh CDN URLs so the
 *      ESM `import React from 'react'` syntax just works.
 *   5. The entry blob is imported as `default`; we render its default export
 *      (auto-injected if missing).
 *
 * Coverage targets (~90% of demo cases):
 *   - Single React/TSX file ✓
 *   - Multi-file React project with relative imports ✓
 *   - Plain HTML / vanilla JS ✓
 *   - Static fragments (HTML body without <html>) ✓
 *
 * Out of scope (would need real WebContainer):
 *   - npm install / require build step (Vite config, postcss, etc.)
 *   - Native modules / wasm
 *   - Server-side code (FastAPI, Express, ...)
 */

import type { ChatMessage } from './store';

export interface CodeBlock {
  uid: string;
  fromMessageId: string;
  lang: string;
  path?: string;
  code: string;
}

const PREVIEWABLE_LANGS = new Set([
  'tsx',
  'jsx',
  'ts',
  'typescript',
  'js',
  'javascript',
  'html',
  'htm',
  'vue',
]);

export function extractCodeBlocks(messages: readonly ChatMessage[]): CodeBlock[] {
  const out: CodeBlock[] = [];
  // Tolerant fence parser: matches both closed (```lang ... ```) and unclosed
  // fences (` ```lang ... <EOF> ` — happens when LLM hits max_tokens mid-code).
  // Strategy: split text on ``` boundaries; odd-indexed segments are inside a fence.
  for (const m of messages) {
    if (m.senderType !== 'agent') continue;
    if (!m.text) continue;
    const parts = m.text.split('```');
    let i = 0;
    for (let p = 1; p < parts.length; p += 2) {
      const segment = parts[p] ?? '';
      const nl = segment.indexOf('\n');
      const header = nl >= 0 ? segment.slice(0, nl) : segment;
      const code = nl >= 0 ? segment.slice(nl + 1) : '';
      const headerMatch = /^([\w-]+)(.*)$/.exec(header.trim());
      if (!headerMatch) continue;
      const lang = (headerMatch[1] ?? '').trim();
      const meta = (headerMatch[2] ?? '').trim();
      const pathMatch = /(?:^|\s)path=([^\s]+)/.exec(meta);
      out.push({
        uid: `${m.id}#${i++}`,
        fromMessageId: m.id,
        lang,
        path: pathMatch?.[1],
        code,
      });
    }
  }
  return out;
}

export function isRunnable(block: CodeBlock): boolean {
  const lang = block.lang.toLowerCase();
  if (lang === 'diff') return false;
  if (PREVIEWABLE_LANGS.has(lang)) return true;
  if (block.path && /\.(tsx?|jsx?|html?|vue)$/i.test(block.path)) return true;
  return false;
}

/** Canonical (basename, no extension) name used in import maps. */
export function canonicalName(block: CodeBlock): string {
  if (block.path) {
    const base = block.path.split(/[\\/]/).pop() ?? block.path;
    return base.replace(/\.(tsx?|jsx?|vue)$/i, '');
  }
  return `inline_${block.uid.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export interface PreviewBuildResult {
  html: string;
  kind: 'react' | 'html' | 'unsupported';
  reason?: string;
  entryName?: string;
  fileCount?: number;
}

/**
 * Build the iframe HTML for the given blocks.
 * Optional `entryUid` picks the entry file (block clicked from a CodeCard);
 * else falls back to App/main/index/last block.
 */
export function buildPreview(
  blocks: readonly CodeBlock[],
  entryUid?: string | null,
): PreviewBuildResult {
  const runnable = blocks.filter(isRunnable);
  if (runnable.length === 0) {
    return { kind: 'unsupported', html: '', reason: '没有可运行的代码块' };
  }

  // Latest version per canonical name wins (agent may overwrite a file in a later message).
  const filesByName = new Map<string, CodeBlock>();
  for (const b of runnable) filesByName.set(canonicalName(b), b);
  const files = [...filesByName.values()];

  // Pick entry.
  let entry: CodeBlock | undefined;
  if (entryUid) entry = runnable.find((b) => b.uid === entryUid);
  if (!entry) entry = pickEntry(files);
  if (!entry) {
    return { kind: 'unsupported', html: '', reason: '无法确定入口文件' };
  }
  const entryName = canonicalName(entry);
  const entryLang = entry.lang.toLowerCase();

  if (entryLang === 'html' || entryLang === 'htm') {
    return {
      kind: 'html',
      entryName,
      fileCount: 1,
      html: ensureHtmlScaffold(entry.code),
    };
  }

  return buildReactProject(files, entryName);
}

function pickEntry(files: CodeBlock[]): CodeBlock | undefined {
  const byName = new Map(files.map((b) => [canonicalName(b), b] as const));
  for (const name of ['App', 'main', 'Main', 'index', 'Index']) {
    const b = byName.get(name);
    if (b) return b;
  }
  return files[files.length - 1];
}

function buildReactProject(blocks: CodeBlock[], entryName: string): PreviewBuildResult {
  const known = new Set(blocks.map(canonicalName));

  // Pass 1: rewrite all relative imports so they resolve to basename in the import map.
  const files: Record<string, string> = {};
  for (const b of blocks) {
    const name = canonicalName(b);
    files[name] = flattenLocalImports(b.code, known);
  }

  // Pass 2: ensure entry has a default export so the boot module can render it.
  if (!/export\s+default\s/.test(files[entryName] ?? '')) {
    const inferred = findRootComponent(files[entryName] ?? '');
    if (inferred) {
      files[entryName] += `\n\nexport default ${inferred};\n`;
    }
  }

  return {
    kind: 'react',
    entryName,
    fileCount: blocks.length,
    html: buildReactHtml(files, entryName),
  };
}

/**
 * Rewrite local imports to be sandbox-safe.
 *
 *   `import X from './Foo'`        → `import X from 'Foo'`   (known module)
 *   `import './App.css'`           → `/* stripped *\/`         (CSS / asset)
 *   `import url from './logo.svg'` → `const url = undefined;` (asset with binding)
 *   `import './unknown'`           → `/* stripped *\/`         (typo / missing)
 *
 * Why bare specifiers for known modules: when the importer is a `blob:` URL
 * (which is the case after we Babel-compile each file into a Blob), `./Foo`
 * gets resolved against the blob URL first — and blob URLs are not
 * hierarchical, so the browser throws `Invalid relative url or base scheme
 * isn't hierarchical` *before* the import map is even consulted. Bare
 * specifiers skip URL resolution and hit the import map directly.
 *
 * Why strip unknown relative imports: same blob-URL problem. CSS imports
 * (very common in agent output) would otherwise crash the whole module load.
 * Tailwind CDN provides our styling so we just drop them.
 */
function flattenLocalImports(code: string, known: Set<string>): string {
  // Side-effect imports: `import './path'`
  code = code.replace(
    /^(\s*)import\s+(['"])(\.\.?\/[^'"]+)\2(\s*;?\s*)$/gm,
    (_full, indent: string, q: string, importPath: string, suffix: string) => {
      const base = importPath.split('/').pop()?.replace(/\.(tsx?|jsx?|vue)$/i, '') ?? '';
      if (known.has(base)) return `${indent}import ${q}${base}${q}${suffix}`;
      return `${indent}/* sandbox: side-effect import stripped (${importPath}) */`;
    },
  );

  // With-binding imports: `import [binding] from './path'`
  code = code.replace(
    /^(\s*)import\s+([^'"\n]+?)\s+from\s+(['"])(\.\.?\/[^'"]+)\3(\s*;?\s*)$/gm,
    (_full, indent: string, binding: string, q: string, importPath: string, suffix: string) => {
      const base = importPath.split('/').pop()?.replace(/\.(tsx?|jsx?|vue)$/i, '') ?? '';
      if (known.has(base)) {
        return `${indent}import ${binding} from ${q}${base}${q}${suffix}`;
      }
      return `${indent}/* sandbox: unresolved ${importPath} */ ${stubForBinding(binding)}`;
    },
  );

  // Dynamic imports: `import('./path')`
  code = code.replace(
    /\bimport\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g,
    (_full, q: string, importPath: string) => {
      const base = importPath.split('/').pop()?.replace(/\.(tsx?|jsx?|vue)$/i, '') ?? '';
      if (known.has(base)) return `import(${q}${base}${q})`;
      return `Promise.resolve({ default: undefined })`;
    },
  );

  return code;
}

/**
 * Given an import clause like `React`, `{ useState, useEffect }`, `* as Lib`,
 * or `React, { useState }`, emit `const X = ...;` declarations so the rest of
 * the file's references don't crash with ReferenceError after we strip the
 * import.
 */
function stubForBinding(binding: string): string {
  const decls: string[] = [];
  let rest = binding.trim();

  // Default import (must be first, no leading `{` or `*`).
  if (rest && !rest.startsWith('{') && !rest.startsWith('*')) {
    const m = /^([a-zA-Z_$][\w$]*)/.exec(rest);
    if (m) {
      decls.push(`const ${m[1]} = undefined;`);
      rest = rest.slice(m[0].length).trim();
      if (rest.startsWith(',')) rest = rest.slice(1).trim();
    }
  }

  // Namespace: `* as Lib`
  const nsMatch = /^\*\s+as\s+([a-zA-Z_$][\w$]*)/.exec(rest);
  if (nsMatch) {
    decls.push(`const ${nsMatch[1]} = {};`);
    rest = rest.slice(nsMatch[0].length).trim();
  }

  // Named: `{ a, b as c }`
  const namedMatch = /^\{\s*([^}]+)\s*\}/.exec(rest);
  if (namedMatch) {
    const names = namedMatch[1]!
      .split(',')
      .map((s) => {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[parts.length - 1] ?? '').trim();
      })
      .filter(Boolean);
    for (const n of names) decls.push(`const ${n} = undefined;`);
  }

  return decls.join(' ');
}

function buildReactHtml(files: Record<string, string>, entryName: string): string {
  // The runtime boot script is intentionally written as a string template so we
  // can embed user files via JSON.stringify and have Babel + esm.sh do the rest
  // in the iframe.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgentHub Preview · ${escapeHtml(entryName)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"></script>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin:0; padding:16px; background:#fff; color:#111; }
  .agenthub-err { font-family: ui-monospace, monospace; background:#fef2f2; color:#991b1b; padding:12px; border-radius:8px; white-space:pre-wrap; font-size:12px; margin:8px 0; }
  .agenthub-loading { font-size:12px; color:#6b7280; }
</style>
</head>
<body>
<div id="__loading" class="agenthub-loading">⏳ Preview 编译中…</div>
<div id="__err"></div>
<div id="root"></div>
<script>
(function() {
  const FILES = ${safeJsonStringify(files)};
  const ENTRY = ${JSON.stringify(entryName)};
  const errEl = document.getElementById('__err');
  const loadingEl = document.getElementById('__loading');
  const showErr = (where, msg) => {
    errEl.innerHTML += '<div class="agenthub-err"><b>'+where+'</b>\\n'+String(msg).replace(/</g,'&lt;')+'</div>';
    loadingEl.style.display = 'none';
  };

  if (typeof Babel === 'undefined') {
    showErr('Loader', 'Babel-standalone failed to load');
    return;
  }

  // 1. Compile each file to ESM JS, register as blob URL.
  // 'automatic' JSX runtime emits \`import { jsx } from 'react/jsx-runtime'\` so
  // we never depend on \`React\` being in scope (agents often skip the import).
  const RESOLVED = {};
  for (const name in FILES) {
    try {
      const out = Babel.transform(FILES[name], {
        presets: [
          ['react', { runtime: 'automatic' }],
          ['typescript', { allExtensions: true, isTSX: true }],
        ],
        filename: name + '.tsx',
        sourceMaps: 'inline',
      });
      const blob = new Blob([out.code], { type: 'application/javascript' });
      RESOLVED[name] = URL.createObjectURL(blob);
    } catch (e) {
      showErr('Compile ' + name, (e && e.message) || e);
      return;
    }
  }

  // 2. Build import map: third-party packages → esm.sh; local files → blobs.
  const importMap = { imports: {
    'react': 'https://esm.sh/react@18.3.1',
    'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
    'react/jsx-dev-runtime': 'https://esm.sh/react@18.3.1/jsx-dev-runtime',
    'react-dom': 'https://esm.sh/react-dom@18.3.1',
    'react-dom/': 'https://esm.sh/react-dom@18.3.1/',
    'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
    'lucide-react': 'https://esm.sh/lucide-react@0.469.0',
    'clsx': 'https://esm.sh/clsx@2.1.1',
    'zustand': 'https://esm.sh/zustand@5.0.2',
  }};
  for (const name in RESOLVED) {
    // Bare specifier keyed directly — works inside blob: importers because
    // bare specifiers skip the relative-URL resolution path entirely.
    importMap.imports[name] = RESOLVED[name];
  }
  const mapEl = document.createElement('script');
  mapEl.type = 'importmap';
  mapEl.textContent = JSON.stringify(importMap);
  document.head.appendChild(mapEl);

  // 3. Boot: import entry's default export and render it, wrapped in an
  // ErrorBoundary so render errors (missing props, etc.) show a friendly
  // hint instead of a raw stack trace from esm.sh react-dom internals.
  const boot = document.createElement('script');
  boot.type = 'module';
  boot.textContent = [
    "import * as __EntryModule from " + JSON.stringify(RESOLVED[ENTRY]) + ";",
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { jsx } from 'react/jsx-runtime';",
    "const Root = __EntryModule.default || __EntryModule.App || __EntryModule.Main;",
    "if (!Root) {",
    "  document.getElementById('__err').innerHTML = '<div class=\\"agenthub-err\\">入口模块没有 default export，也没有 App / Main 命名导出</div>';",
    "  document.getElementById('__loading').style.display = 'none';",
    "} else {",
    "  class __EB extends React.Component {",
    "    constructor(p){ super(p); this.state = { error: null }; }",
    "    static getDerivedStateFromError(e){ return { error: e }; }",
    "    componentDidCatch(e){ console.error('[preview]', e); }",
    "    render(){",
    "      if (this.state.error) {",
    "        const msg = (this.state.error && this.state.error.message) || String(this.state.error);",
    "        return jsx('div', { className: 'agenthub-err', children: '⚠️ 渲染错误：' + msg + (msg.includes('undefined') ? '\\\\n\\\\n提示：当前入口可能是需要 props 的子组件。请在左侧文件列表点击 App / Main 类的顶层文件作为入口。' : '') });",
    "      }",
    "      return this.props.children;",
    "    }",
    "  }",
    "  document.getElementById('__loading').style.display = 'none';",
    "  createRoot(document.getElementById('root')).render(jsx(__EB, { children: jsx(Root, {}) }));",
    "}",
  ].join("\\n");
  document.body.appendChild(boot);
})();

function __trimStack(s) {
  if (!s) return '';
  return String(s).split('\\n').slice(0, 4).join('\\n');
}
window.addEventListener('error', (e) => {
  const errEl = document.getElementById('__err');
  if (errEl) errEl.innerHTML += '<div class="agenthub-err">'+ __trimStack(e.error && e.error.stack || e.message) +'</div>';
});
window.addEventListener('unhandledrejection', (e) => {
  const errEl = document.getElementById('__err');
  if (errEl) errEl.innerHTML += '<div class="agenthub-err">'+ __trimStack(e.reason && e.reason.stack || e.reason) +'</div>';
});
</script>
</body>
</html>`;
}

function ensureHtmlScaffold(html: string): string {
  if (/<html[\s>]/i.test(html)) {
    if (!/cdn\.tailwindcss\.com/.test(html)) {
      return html.replace(
        /<head[^>]*>/i,
        (m) => `${m}\n<script src="https://cdn.tailwindcss.com"></script>`,
      );
    }
    return html;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preview</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:system-ui,sans-serif;padding:16px;background:#fff;color:#111}</style>
</head>
<body>
${html}
</body>
</html>`;
}

/**
 * Heuristic: pick a likely root component name for default-export injection.
 *   1. export default function Foo
 *   2. export default Foo
 *   3. Last PascalCase function/const declaration.
 */
function findRootComponent(code: string): string | null {
  const m1 = /export\s+default\s+function\s+(\w+)/.exec(code);
  if (m1) return m1[1] ?? null;
  const m2 = /export\s+default\s+(\w+)\s*;?/.exec(code);
  if (m2) return m2[1] ?? null;
  let last: string | null = null;
  for (const m of code.matchAll(/(?:function|const|let|var)\s+([A-Z]\w*)\b/g)) {
    last = m[1] ?? last;
  }
  return last;
}

/** JSON.stringify that escapes `</script>` so injecting into <script> is safe. */
function safeJsonStringify(v: unknown): string {
  return JSON.stringify(v).replace(/<\/script/gi, '<\\/script');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c),
  );
}
