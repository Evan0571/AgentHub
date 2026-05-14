// Smoke: end-to-end Vercel deploy via our WS deploy op.
// Requires VERCEL_TOKEN in server's .env. Watches deploy_status transitions
// until 'ready' (success) or 'failed', then fetches the resulting URL.

import WebSocket from 'ws';

const HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>AgentHub smoke</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
<div class="text-center">
<h1 class="text-4xl font-bold">AgentHub × Vercel ✅</h1>
<p class="mt-2 opacity-80">Deployed at ${new Date().toISOString()}</p>
</div></body></html>`;

const ws = new WebSocket('ws://localhost:4000/ws');
const start = Date.now();
let target = null;
const seen = [];

ws.on('open', () => {
  console.log('[smoke] requesting Vercel deploy …');
  ws.send(JSON.stringify({
    event: 'client_event',
    data: {
      op: 'deploy',
      conversationId: 'smoke-vercel',
      target: 'vercel',
      html: HTML,
      projectName: 'agenthub-smoke-' + Date.now().toString(36).slice(-6),
    },
  }));
});

ws.on('message', async (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.event !== 'server_event') return;
  const e = f.data;
  if (e.op !== 'deploy_status') return;
  if (target === null) {
    target = e.target;
    console.log(`[target resolved] ${target}${target === 'mock' ? ' (no VERCEL_TOKEN; fell back to mock)' : ''}`);
  }
  seen.push(`${e.status}${e.url ? ' → ' + e.url : ''}`);
  console.log(`  ${Math.round((Date.now() - start) / 1000)}s  ${e.status}${e.url ? '  ' + e.url : ''}${e.errorMessage ? '  err=' + e.errorMessage : ''}`);
  if (e.status === 'ready') {
    try {
      const r = await fetch(e.url);
      const t = await r.text();
      const ok = t.includes('AgentHub × Vercel');
      console.log(`\n[fetch] ${r.status} ${ok ? '✅ HTML reachable on public URL' : '❌ wrong content'}`);
      console.log(`status sequence: ${seen.join(' → ')}`);
      console.log(`total elapsed: ${Date.now() - start}ms`);
    } catch (err) {
      console.error('fetch error:', err);
    }
    ws.close();
    process.exit(0);
  }
  if (e.status === 'failed') {
    console.error('FAILED:', e.errorMessage);
    ws.close();
    process.exit(2);
  }
});

setTimeout(() => { console.error('\n[timeout 120s]'); process.exit(1); }, 120_000);
