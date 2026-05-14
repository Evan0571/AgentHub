// End-to-end persistence smoke:
//  1. Fetch c1's state via REST → record baseline message count
//  2. Send a user_msg via WS with @deepseek-v3
//  3. Wait for agent's msg_done
//  4. Re-fetch state → confirm user msg + agent msg both persisted

import WebSocket from 'ws';

const STATE_URL = 'http://localhost:4000/api/conversations/c1/state';

async function fetchState() {
  const r = await fetch(STATE_URL);
  const data = await r.json();
  return data;
}

async function main() {
  const before = await fetchState();
  console.log(`[before] ${before.messages.length} messages`);

  const ws = new WebSocket('ws://localhost:4000/ws');
  const probe = '持久化 smoke 探针 ' + Date.now();
  let agentReplied = false;

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          event: 'client_event',
          data: {
            op: 'user_msg',
            conversationId: 'c1',
            content: { kind: 'text', text: probe },
            mentions: ['deepseek-v3'],
          },
        }),
      );
    });
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.event !== 'server_event') return;
      const e = f.data;
      if (e.op === 'msg_done' && e.usage) {
        agentReplied = true;
        ws.close();
        resolve(null);
      }
      if (e.op === 'msg_error') reject(new Error(e.error.message));
    });
    setTimeout(() => reject(new Error('ws timeout')), 30_000);
  });

  // Give the server a beat to flush the insert.
  await new Promise((r) => setTimeout(r, 500));

  const after = await fetchState();
  console.log(`[after]  ${after.messages.length} messages (agentReplied=${agentReplied})`);

  const newOnes = after.messages.slice(before.messages.length);
  for (const m of newOnes) {
    console.log(`  + [${m.senderType}] ${m.senderId}: ${m.text.replace(/\n/g, ' ').slice(0, 80)}`);
  }

  const hasUser = newOnes.some((m) => m.senderType === 'user' && m.text === probe);
  const hasAgent = newOnes.some((m) => m.senderType === 'agent' && m.senderId === 'deepseek-v3');

  console.log(`\n  user msg persisted: ${hasUser ? '✅' : '❌'}`);
  console.log(`  agent msg persisted: ${hasAgent ? '✅' : '❌'}`);

  process.exit(hasUser && hasAgent ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
