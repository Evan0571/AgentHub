// Smoke: ensure CodexAdapter (gpt-4o-mini via OpenAI) actually streams.
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/ws');
const start = Date.now();
let tokens = 0;

ws.on('open', () => {
  console.log('[smoke] @codex …');
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'smoke-codex',
        content: { kind: 'text', text: '用一句话介绍你是哪个公司的什么模型。' },
        mentions: ['codex'],
      },
    }),
  );
});

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.event !== 'server_event') return;
  const e = f.data;
  if (e.op === 'msg_started') console.log('[started]', e.message.senderId);
  if (e.op === 'msg_token') {
    tokens++;
    process.stdout.write(e.delta);
  }
  if (e.op === 'msg_error') {
    console.error('\n[error]', e.error);
    process.exit(1);
  }
  if (e.op === 'msg_done' && e.usage) {
    console.log(`\n[done] tokens=${tokens} usage=${JSON.stringify(e.usage)} elapsed=${Date.now() - start}ms`);
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('\n[timeout]');
  process.exit(1);
}, 60_000);
