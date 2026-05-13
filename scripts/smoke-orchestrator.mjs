// End-to-end smoke for the Orchestrator:
//  - send "@orchestrator <goal>"
//  - capture plan_update events and task message activity
//  - exit when the plan ends (succeeded or failed)

import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/ws');
const startedAt = Date.now();

let lastPlan = null;
let planUpdates = 0;
const taskMsgs = new Map(); // msgId -> { sender, chars, thinking }

ws.on('open', () => {
  console.log('[smoke] @orchestrator …');
  ws.send(
    JSON.stringify({
      event: 'client_event',
      data: {
        op: 'user_msg',
        conversationId: 'c2',
        content: {
          kind: 'text',
          text: '@orchestrator 做一个极简的 React + Vite 待办清单 demo，要前端实现 + 后端 mock API + 简单部署说明，分阶段产出。',
        },
        mentions: ['orchestrator'],
      },
    }),
  );
});

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.event !== 'server_event') return;
  const e = frame.data;
  if (e.op === 'plan_update') {
    planUpdates++;
    lastPlan = e.plan;
    const counts = countByStatus(lastPlan);
    console.log(
      `[plan_update #${planUpdates}] v${lastPlan.version} status=${lastPlan.status} ` +
        `tasks=${counts.total} succ=${counts.succeeded} run=${counts.running} fail=${counts.failed}`,
    );
    if (lastPlan.status === 'succeeded' || lastPlan.status === 'failed') {
      console.log('\n=== Final plan ===');
      for (const t of lastPlan.tasks) {
        console.log(
          `  ${t.id}  [${t.status}]  goal="${t.goal}"  assignee=${t.assigneeAgentId ?? '-'}  inputs=[${t.inputs.join(',')}]`,
        );
      }
      console.log(`\nTotal elapsed: ${Date.now() - startedAt}ms`);
      console.log(`Task messages: ${taskMsgs.size}`);
      ws.close();
      process.exit(lastPlan.status === 'succeeded' ? 0 : 2);
    }
  }
  if (e.op === 'msg_started') {
    taskMsgs.set(e.message.id, { sender: e.message.senderId, chars: 0, thinking: 0 });
  }
  if (e.op === 'msg_token') {
    const b = taskMsgs.get(e.msgId);
    if (b) b.chars += e.delta.length;
  }
  if (e.op === 'msg_thinking') {
    const b = taskMsgs.get(e.msgId);
    if (b) b.thinking += e.delta.length;
  }
  if (e.op === 'msg_done') {
    const b = taskMsgs.get(e.msgId);
    if (b) {
      console.log(`  [msg_done] ${b.sender}: ${b.chars} chars${b.thinking ? ` (+${b.thinking}ch thinking)` : ''}`);
    }
  }
});

function countByStatus(plan) {
  let total = 0,
    succeeded = 0,
    running = 0,
    failed = 0;
  for (const t of plan.tasks) {
    total++;
    if (t.status === 'succeeded') succeeded++;
    if (t.status === 'running' || t.status === 'awaiting-critic') running++;
    if (t.status === 'failed') failed++;
  }
  return { total, succeeded, running, failed };
}

setTimeout(() => {
  console.error('\n[timeout 180s]');
  process.exit(1);
}, 180_000);
