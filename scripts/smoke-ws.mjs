// Smoke test: connect to the local WS gateway, send one user message,
// print every server event we receive. Exits on msg_done or timeout.

import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://localhost:4000/ws';
const ws = new WebSocket(url);

const startedAt = Date.now();
let tokens = 0;
let thinkingChars = 0;

ws.on('open', () => {
  console.log(`[smoke] connected ${url}`);
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'smoke-1',
        content: { kind: 'text', text: '用一句话介绍 DeepSeek。' },
        mentions: ['deepseek-v3'],
      },
    }),
  );
});

ws.on('message', (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    console.log('[non-json]', raw.toString());
    return;
  }
  if (frame.event !== 'server_event') return;
  const e = frame.data;
  switch (e.op) {
    case 'msg_started':
      console.log(`[started] msgId=${e.message.id} sender=${e.message.senderId}`);
      break;
    case 'msg_token':
      tokens++;
      process.stdout.write(e.delta);
      break;
    case 'msg_thinking':
      thinkingChars += e.delta.length;
      break;
    case 'msg_done':
      if (!e.usage) {
        // user-echo done; keep waiting for the real agent reply
        break;
      }
      console.log(
        `\n[done] tokens=${tokens} thinking=${thinkingChars}ch ` +
          `usage=${JSON.stringify(e.usage)} elapsed=${Date.now() - startedAt}ms`,
      );
      ws.close();
      process.exit(0);
      break;
    case 'msg_error':
      console.error('\n[msg_error]', e.error);
      ws.close();
      process.exit(1);
      break;
    case 'error':
      console.error('[error]', e);
      break;
    default:
      console.log('[evt]', e.op);
  }
});

ws.on('error', (e) => {
  console.error('[ws error]', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('\n[timeout 60s]');
  process.exit(1);
}, 60_000);
