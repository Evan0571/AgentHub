// Smoke test for multi-@ group chat: send a message mentioning V3 and R1 in parallel.

import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/ws');
const startedAt = Date.now();

const bufs = new Map();     // msgId -> { sender, text }
let doneCount = 0;
const expected = 2;

ws.on('open', () => {
  console.log('[smoke] sending @deepseek-v3 @deepseek-r1 ...');
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'c2',
        content: {
          kind: 'text',
          text: '@deepseek-v3 @deepseek-r1 各自用一句话介绍你们自己的特点。',
        },
        mentions: ['deepseek-v3', 'deepseek-r1'],
      },
    }),
  );
});

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.event !== 'server_event') return;
  const e = frame.data;
  if (e.op === 'msg_started') {
    bufs.set(e.message.id, { sender: e.message.senderId, text: '', think: 0 });
    console.log(`[started] ${e.message.senderId} (msg=${e.message.id})`);
  }
  if (e.op === 'msg_token') {
    const b = bufs.get(e.msgId);
    if (b) b.text += e.delta;
  }
  if (e.op === 'msg_thinking') {
    const b = bufs.get(e.msgId);
    if (b) b.think += e.delta.length;
  }
  if (e.op === 'msg_done' && e.usage) {
    doneCount++;
    const b = bufs.get(e.msgId);
    console.log(
      `[done] ${b?.sender} tokens=${e.usage.completionTokens} thinking=${b?.think}ch latency=${e.usage.latencyMs}ms`,
    );
    console.log(`  reply: ${b?.text.replace(/\n/g, ' ').slice(0, 120)}...`);
    if (doneCount === expected) {
      console.log(`\n[all done] ${doneCount}/${expected} agents replied; total=${Date.now() - startedAt}ms`);
      ws.close();
      process.exit(0);
    }
  }
});

setTimeout(() => {
  console.error('\n[timeout 90s] doneCount=' + doneCount);
  process.exit(1);
}, 90_000);
