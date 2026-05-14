// Smoke: ask DeepSeek for a multi-file React project, then run our preview
// engine on the extracted blocks. Dump the generated HTML so it can be opened
// directly in a browser to verify multi-file imports work.
//
// Run after `pnpm dev` is up. Generates:
//   scripts/smoke-preview-multi.html

import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- minimal mirror of preview-utils.ts buildPreview (multi-file path) ---
function canonicalName(b) {
  if (b.path) {
    const base = b.path.split(/[\\/]/).pop() ?? b.path;
    return base.replace(/\.(tsx?|jsx?|vue)$/i, '');
  }
  return 'inline_' + b.uid.replace(/[^a-z0-9]/gi, '_');
}
function stubForBinding(binding) {
  const decls = [];
  let rest = binding.trim();
  if (rest && !rest.startsWith('{') && !rest.startsWith('*')) {
    const m = /^([a-zA-Z_$][\w$]*)/.exec(rest);
    if (m) {
      decls.push(`const ${m[1]} = undefined;`);
      rest = rest.slice(m[0].length).trim();
      if (rest.startsWith(',')) rest = rest.slice(1).trim();
    }
  }
  const ns = /^\*\s+as\s+([a-zA-Z_$][\w$]*)/.exec(rest);
  if (ns) {
    decls.push(`const ${ns[1]} = {};`);
    rest = rest.slice(ns[0].length).trim();
  }
  const nm = /^\{\s*([^}]+)\s*\}/.exec(rest);
  if (nm) {
    const names = nm[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    for (const n of names) decls.push(`const ${n} = undefined;`);
  }
  return decls.join(' ');
}
function flattenLocalImports(code, known) {
  code = code.replace(
    /^(\s*)import\s+(['"])(\.\.?\/[^'"]+)\2(\s*;?\s*)$/gm,
    (full, indent, q, importPath, suffix) => {
      const base = importPath.split('/').pop().replace(/\.(tsx?|jsx?|vue)$/i, '');
      if (known.has(base)) return `${indent}import ${q}${base}${q}${suffix}`;
      return `${indent}/* stripped ${importPath} */`;
    },
  );
  code = code.replace(
    /^(\s*)import\s+([^'"\n]+?)\s+from\s+(['"])(\.\.?\/[^'"]+)\3(\s*;?\s*)$/gm,
    (full, indent, binding, q, importPath, suffix) => {
      const base = importPath.split('/').pop().replace(/\.(tsx?|jsx?|vue)$/i, '');
      if (known.has(base)) return `${indent}import ${binding} from ${q}${base}${q}${suffix}`;
      return `${indent}/* stripped ${importPath} */ ${stubForBinding(binding)}`;
    },
  );
  return code;
}
function findRoot(code) {
  let m = /export\s+default\s+function\s+(\w+)/.exec(code);
  if (m) return m[1];
  m = /export\s+default\s+(\w+)/.exec(code);
  if (m) return m[1];
  let last = null;
  for (const x of code.matchAll(/(?:function|const|let|var)\s+([A-Z]\w*)\b/g)) last = x[1];
  return last;
}
function buildHtml(files, entryName) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8" />
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"></script>
<style>body{font-family:system-ui;padding:16px;}.err{font-family:monospace;background:#fef2f2;color:#991b1b;padding:12px;border-radius:6px;white-space:pre-wrap;}</style>
</head><body><div id="__loading">⏳ compiling…</div><div id="__err"></div><div id="root"></div>
<script>
const FILES = ${JSON.stringify(files)};
const ENTRY = ${JSON.stringify(entryName)};
const RESOLVED = {};
for (const n in FILES) {
  try { const out = Babel.transform(FILES[n], {presets:[['react',{runtime:'automatic'}],['typescript',{allExtensions:true,isTSX:true}]],filename:n+'.tsx'}); RESOLVED[n] = URL.createObjectURL(new Blob([out.code],{type:'application/javascript'})); }
  catch(e){ document.getElementById('__err').innerHTML='<div class=err><b>'+n+'</b>: '+e.message+'</div>'; throw e;}
}
const im={imports:{
  'react':'https://esm.sh/react@18.3.1','react/jsx-runtime':'https://esm.sh/react@18.3.1/jsx-runtime','react/jsx-dev-runtime':'https://esm.sh/react@18.3.1/jsx-dev-runtime',
  'react-dom':'https://esm.sh/react-dom@18.3.1','react-dom/client':'https://esm.sh/react-dom@18.3.1/client',
  'lucide-react':'https://esm.sh/lucide-react@0.469.0','clsx':'https://esm.sh/clsx@2.1.1','zustand':'https://esm.sh/zustand@5.0.2'
}};
for (const n in RESOLVED){ im.imports[n]=RESOLVED[n]; }
const ms=document.createElement('script'); ms.type='importmap'; ms.textContent=JSON.stringify(im); document.head.appendChild(ms);
const boot=document.createElement('script'); boot.type='module';
boot.textContent="import * as M from "+JSON.stringify(RESOLVED[ENTRY])+";import * as React from 'react';import {createRoot} from 'react-dom/client';import {jsx} from 'react/jsx-runtime';const R=M.default||M.App||M.Main;class EB extends React.Component{constructor(p){super(p);this.state={error:null}}static getDerivedStateFromError(e){return {error:e}}componentDidCatch(e){console.error('[preview]',e)}render(){if(this.state.error){return jsx('div',{className:'err',children:'\\u26a0\\ufe0f Render error: '+(this.state.error.message||this.state.error)})}return this.props.children}}document.getElementById('__loading').style.display='none';createRoot(document.getElementById('root')).render(jsx(EB,{children:jsx(R,{})}));";
document.body.appendChild(boot);
window.addEventListener('error',e=>{document.getElementById('__err').innerHTML+='<div class=err>'+(e.error&&e.error.stack||e.message)+'</div>';});
window.addEventListener('unhandledrejection',e=>{document.getElementById('__err').innerHTML+='<div class=err>'+(e.reason&&e.reason.stack||e.reason)+'</div>';});
</script></body></html>`;
}
// --- end mirror ---

const ws = new WebSocket('ws://localhost:4000/ws');
let buf = '';

ws.on('open', () => {
  console.log('[smoke] requesting multi-file Todo project...');
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'smoke-multi',
        content: {
          kind: 'text',
          text:
            '用 React + TypeScript 实现一个待办应用，请拆成 3 个文件：' +
            '1) App.tsx（入口） 2) TodoList.tsx（列表组件） 3) TodoItem.tsx（单条组件）。' +
            '组件之间用 ESM `import` 互相引用（相对路径）。使用 Tailwind className。',
        },
        mentions: ['deepseek-v3'],
      },
    }),
  );
});

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.event !== 'server_event') return;
  const e = frame.data;
  if (e.op === 'msg_token') buf += e.delta;
  if (e.op === 'msg_done' && e.usage) {
    const blocks = [];
    const re = /```([\w-]+)([^\n]*)\n([\s\S]*?)```/g;
    let m;
    let i = 0;
    while ((m = re.exec(buf)) !== null) {
      const lang = m[1].trim();
      const meta = m[2].trim();
      const code = m[3];
      const pm = /(?:^|\s)path=([^\s]+)/.exec(meta);
      blocks.push({ uid: 'm#' + i++, fromMessageId: 'm', lang, path: pm?.[1], code });
    }
    console.log(`\nExtracted ${blocks.length} code blocks:`);
    for (const b of blocks) console.log(`  ${canonicalName(b)} (${b.path ?? '-'}) [${b.lang}] ${b.code.length}ch`);

    // Build preview
    const known = new Set(blocks.map(canonicalName));
    const files = {};
    for (const b of blocks) files[canonicalName(b)] = flattenLocalImports(b.code, known);
    const entryName = ['App', 'main', 'index'].find((n) => files[n]) || Object.keys(files).pop();
    if (!/export\s+default\s/.test(files[entryName] || '')) {
      const root = findRoot(files[entryName]);
      if (root) files[entryName] += `\n\nexport default ${root};\n`;
    }
    const html = buildHtml(files, entryName);
    const outPath = path.join(__dirname, 'smoke-preview-multi.html');
    writeFileSync(outPath, html, 'utf8');
    console.log(`\nEntry: ${entryName}`);
    console.log(`Wrote ${outPath} (${html.length} bytes)`);
    console.log(`Open it in a browser to verify multi-file imports resolve and the app renders.`);
    ws.close();
    process.exit(0);
  }
});

// Heartbeat
const tStart = Date.now();
const hb = setInterval(() => {
  process.stderr.write(`  ...${((Date.now() - tStart) / 1000).toFixed(0)}s buf=${buf.length}ch\n`);
}, 5000);
setTimeout(() => {
  clearInterval(hb);
  console.error('timeout', buf.length, 'chars buffered');
  process.exit(1);
}, 180_000);
