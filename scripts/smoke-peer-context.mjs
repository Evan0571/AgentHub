// Smoke: same prompt that previously caused "all agents write all styles".
// Now each agent should only produce ONE counter implementation (its own).
//
// Heuristic check: count fenced code blocks per agent reply — should be 1.

import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/ws');
const start = Date.now();
const bufs = new Map(); // msgId -> { sender, text, done }
let doneCount = 0;
const expected = 2;

ws.on('open', () => {
  console.log('[smoke] @codex + @deepseek-v3 each write a Counter…');
  ws.send(JSON.stringify({
    event: 'client_event',
    data: {
      op: 'user_msg',
      conversationId: 'smoke-peer',
      content: { kind: 'text', text: '各写一个 React Counter 组件，用各自最熟悉的风格' },
      mentions: ['codex', 'deepseek-v3'],
    },
  }));
});

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.event !== 'server_event') return;
  const e = f.data;
  if (e.op === 'msg_started') {
    bufs.set(e.message.id, { sender: e.message.senderId, text: '' });
  }
  if (e.op === 'msg_token') {
    const b = bufs.get(e.msgId);
    if (b) b.text += e.delta;
  }
  if (e.op === 'msg_done' && e.usage) {
    doneCount++;
    const b = bufs.get(e.msgId);
    const fences = b ? (b.text.match(/```/g) ?? []).length / 2 : 0;
    console.log(`[done] ${b?.sender}: fences=${fences}  chars=${b?.text.length}`);
    if (doneCount === expected) {
      console.log(`\n=== summary ===`);
      let allOk = true;
      for (const b of bufs.values()) {
        if (!b.text) continue;
        const fences = (b.text.match(/```/g) ?? []).length / 2;
        const ok = fences === 1;
        if (!ok) allOk = false;
        console.log(`  ${b.sender}: ${fences} code block(s) ${ok ? '✅' : '❌ should be 1'}`);
      }
      console.log(`elapsed=${Date.now() - start}ms`);
      ws.close();
      process.exit(allOk ? 0 : 2);
    }
  }
});

setTimeout(() => { console.error('\ntimeout'); process.exit(1); }, 60_000);
