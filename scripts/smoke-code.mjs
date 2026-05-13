// Smoke test for CodeCard: ask DeepSeek for a code-rich response,
// concatenate stream tokens, print the raw response so we can verify
// it contains ```lang path=... fenced blocks.

import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/ws');

let buf = '';
const startedAt = Date.now();

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'smoke',
        content: {
          kind: 'text',
          text: '帮我写一个 React + TypeScript 的 Counter 组件，含加减和重置按钮，请给出完整文件。',
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
    console.log(buf);
    console.log('\n---');
    console.log(`tokens=${e.usage.completionTokens} elapsed=${Date.now() - startedAt}ms`);
    const fences = [...buf.matchAll(/```([\w-]+)([^\n]*)/g)];
    console.log(`fence count=${fences.length}`);
    for (const f of fences) console.log(`  lang="${f[1]}" meta="${f[2].trim()}"`);
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 60_000);
