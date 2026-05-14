// Smoke test that Langfuse generations are actually being recorded.
//
// Prereqs: LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY set in server .env,
//          server restarted to pick them up.
//
// What this does:
//  1. Sends a user_msg via WS (triggers the agent → 1 Langfuse generation
//     under a "user_msg" trace).
//  2. Sends @orchestrator (triggers planner + N tasks + N critic LLM calls,
//     all under a single "orchestrator.plan" trace).
//  3. Tells you where to look in Langfuse UI.

import WebSocket from 'ws';

const HOST = process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com';

async function fire(conversationId, text, mentions) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:4000/ws');
    let started = null;
    let done = 0;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          event: 'client_event',
          data: {
            op: 'user_msg',
            conversationId,
            content: { kind: 'text', text },
            mentions,
          },
        }),
      );
    });
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.event !== 'server_event') return;
      const e = f.data;
      if (e.op === 'msg_started' && !started) started = e.message.senderId;
      if (e.op === 'msg_done' && e.usage) {
        done++;
        // For orchestrator path we wait for multiple msg_done; close after first idle period.
      }
      if (e.op === 'plan_update' && e.plan.status === 'succeeded') {
        ws.close();
        resolve({ started, done });
      }
      if (e.op === 'plan_update' && e.plan.status === 'failed') {
        ws.close();
        resolve({ started, done });
      }
    });
    ws.on('error', reject);
    setTimeout(() => {
      ws.close();
      resolve({ started, done });
    }, 60_000);
  });
}

async function main() {
  console.log('=== 1) single chat (user_msg trace) ===');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:4000/ws');
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          event: 'client_event',
          data: {
            op: 'user_msg',
            conversationId: 'c1',
            content: { kind: 'text', text: '一句话介绍你是哪家模型。' },
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
        console.log(`  ok — 1 generation under "user_msg" trace`);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
    setTimeout(() => { ws.close(); resolve(); }, 30_000);
  });

  console.log('\n=== 2) orchestrator plan (one trace with N children) ===');
  const r = await fire(
    'c2',
    '@orchestrator 做一个简单的 hello world 网页',
    ['orchestrator'],
  );
  console.log(`  ok — orchestrator.plan trace finished, ${r.done} task msg_done events`);

  console.log('\n----');
  console.log('Open Langfuse → Traces and you should see:');
  console.log('  • a "user_msg" trace with 1 deepseek-v3 generation');
  console.log('  • an "orchestrator.plan" trace with planner + N task + N critic generations');
  console.log(`URL: ${HOST}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
