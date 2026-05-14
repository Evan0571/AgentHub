// Smoke: ask DeepSeek for a small React component, then run our preview
// builder against the first ```tsx block and dump the rendered HTML so we
// can open it in a browser to verify the sandbox.

import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirror of buildPreview from apps/web/lib/preview-utils.ts (kept in lockstep).
function buildPreview(code) {
  const stripped = code
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '/* import stripped */')
    .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^\s*export\s+/gm, '');
  const m1 = /export\s+default\s+function\s+(\w+)/.exec(code);
  const m2 = /export\s+default\s+(\w+)/.exec(code);
  let last = null;
  for (const m of code.matchAll(/(?:function|const|let|var)\s+([A-Z]\w*)\b/g)) last = m[1];
  const root = (m1 && m1[1]) || (m2 && m2[1]) || last;
  const renderExpr = root
    ? `React.createElement(${root})`
    : `React.createElement(__default__ ?? (() => React.createElement('pre', null, 'no component')))`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8" />
<script src="https://cdn.tailwindcss.com"></script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"></script>
<style>body{font-family:system-ui;padding:16px;}</style></head>
<body><div id="root"></div><div id="__err"></div>
<script type="text/babel" data-presets="env,react,typescript">
const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, Fragment } = React;
let __default__;
try {
${stripped}
ReactDOM.createRoot(document.getElementById('root')).render(${renderExpr});
} catch (e) { document.getElementById('__err').innerHTML = '<pre style="color:red">' + (e.stack || e) + '</pre>'; }
</script></body></html>`;
}

const ws = new WebSocket('ws://localhost:4000/ws');
let buf = '';

ws.on('open', () => {
  console.log('[smoke] requesting Counter...');
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'smoke-preview',
        content: {
          kind: 'text',
          text: '写一个 React Counter 组件，函数命名 Counter，包含 +/-/重置按钮，用 Tailwind 风格的 className。',
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
    const match = /```(?:tsx|jsx)[^\n]*\n([\s\S]*?)```/.exec(buf);
    if (!match) {
      console.error('no tsx block found in:\n', buf);
      process.exit(1);
    }
    const code = match[1];
    console.log(`code block: ${code.length} chars`);
    const html = buildPreview(code);
    const outPath = path.join(__dirname, 'smoke-preview.html');
    writeFileSync(outPath, html, 'utf8');
    console.log(`\nWrote ${outPath} (${html.length} bytes)`);
    console.log(`Open it in a browser to verify the Counter renders + works.`);
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 60_000);
