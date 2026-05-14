// Smoke test for the mock deploy path. Sends a deploy WS event with a small
// HTML payload, listens for deploy_status events, and finally fetches the
// served URL to verify the local mock server returns the right HTML.

import WebSocket from 'ws';

const HTML = `<!DOCTYPE html><html><body><h1 style="font-family:system-ui">AgentHub Deploy Smoke ✅</h1><p>Built at ${new Date().toISOString()}</p></body></html>`;

const ws = new WebSocket('ws://localhost:4000/ws');
let readyUrl = null;
const seen = [];

ws.on('open', () => {
  console.log('[smoke] triggering mock deploy …');
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'deploy',
        conversationId: 'smoke-deploy',
        target: 'mock',
        html: HTML,
        projectName: 'agenthub-smoke',
      },
    }),
  );
});

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.event !== 'server_event') return;
  const e = frame.data;
  if (e.op !== 'deploy_status') return;
  seen.push(e.status);
  console.log(`[deploy_status] ${e.status}${e.url ? ' → ' + e.url : ''}`);
  if (e.status === 'ready') {
    readyUrl = e.url;
    onReady();
  }
  if (e.status === 'failed') {
    console.error('FAILED:', e.errorMessage);
    process.exit(1);
  }
});

async function onReady() {
  ws.close();
  if (!readyUrl) { process.exit(1); return; }
  try {
    const res = await fetch(readyUrl);
    const body = await res.text();
    const ok = body.includes('AgentHub Deploy Smoke');
    console.log(`\n[fetch] ${res.status} ${ok ? '✅ HTML served correctly' : '❌ wrong content'}`);
    console.log(`status sequence: ${seen.join(' → ')}`);
    process.exit(ok ? 0 : 2);
  } catch (e) {
    console.error('fetch error:', e);
    process.exit(1);
  }
}

setTimeout(() => {
  console.error('[timeout 15s]');
  process.exit(1);
}, 15_000);
