import { Inject, Injectable } from '@nestjs/common';
import type { AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { Plan, PlanTask, ServerEvent, TaskStatus } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { CriticService } from './critic.service.js';
import { PlanService } from './plan.service.js';

const MAX_PARALLEL = 5;
const MAX_RETRIES = 1;

@Injectable()
export class ExecutorService {
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly critic: CriticService,
    private readonly plans: PlanService,
  ) {}

  /**
   * Topological execution with bounded parallelism.
   * Emits plan_update on every status transition + streams task output as
   * normal agent messages in the conversation.
   */
  async run(plan: Plan, send: (e: ServerEvent) => void): Promise<void> {
    plan.status = 'executing';
    await this.plans.save(plan);
    send({ op: 'plan_update', plan: snapshot(plan) });

    const byId = new Map(plan.tasks.map((t) => [t.id, t] as const));
    const inflight = new Set<string>();

    const tick = async () => {
      while (true) {
        const remaining = plan.tasks.filter((t) =>
          ['pending', 'ready'].includes(t.status),
        );
        if (remaining.length === 0 && inflight.size === 0) return;

        const ready = remaining.filter((t) => isReady(t, byId) && !inflight.has(t.id));
        const slots = MAX_PARALLEL - inflight.size;

        for (const task of ready.slice(0, slots)) {
          inflight.add(task.id);
          this.executeTask(task, plan, send)
            .catch((e) => {
              console.error('[executor] task threw', task.id, e);
              this.markTask(plan, task, 'failed', send, {
                code: 'INTERNAL',
                message: String(e),
              });
            })
            .finally(() => {
              inflight.delete(task.id);
            });
        }

        if (inflight.size === 0 && ready.length === 0) {
          // Nothing executable; broken DAG.
          send({
            op: 'error',
            code: 'PLAN_DEADLOCK',
            message: 'No ready task and no inflight tasks — broken DAG',
            retryable: false,
          });
          return;
        }
        await sleep(80);
      }
    };

    await tick();

    const failed = plan.tasks.some((t) => t.status === 'failed');
    plan.status = failed ? 'failed' : 'succeeded';
    plan.updatedAt = new Date().toISOString();
    plan.version++;
    await this.plans.save(plan);
    send({ op: 'plan_update', plan: snapshot(plan) });
  }

  async cancel(taskId: string): Promise<void> {
    this.aborts.get(taskId)?.abort();
  }

  private async executeTask(
    task: PlanTask,
    plan: Plan,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    this.markTask(plan, task, 'running', send);

    const adapterId =
      task.assigneeAgentId && this.registry.has(task.assigneeAgentId)
        ? task.assigneeAgentId
        : this.registry.has('deepseek-v3')
          ? 'deepseek-v3'
          : 'mock';

    const adapter = this.registry.get(adapterId);
    task.assigneeAgentId = adapterId;
    task.startedAt = new Date().toISOString();

    const msgId = cryptoRandomId();
    const ctrl = new AbortController();
    this.aborts.set(task.id, ctrl);

    send({
      op: 'msg_started',
      message: {
        id: msgId,
        conversationId: plan.conversationId,
        senderType: 'agent',
        senderId: adapterId,
        createdAt: new Date().toISOString(),
      },
    });

    // Prefix the agent reply with a task header so the chat is readable.
    const header = `### 🔧 ${task.id} · ${task.goal}\n\n`;
    send({ op: 'msg_token', msgId, delta: header });

    const upstreamContext = collectUpstream(task, plan);
    const userMsg =
      `任务目标：${task.goal}\n\n` +
      (upstreamContext ? `上游任务（已完成）：\n${upstreamContext}\n\n` : '') +
      `产出本任务的最终结果。如涉及代码，按 \`\`\`lang path=... 给出。`;

    const req: ChatRequest = {
      taskId: task.id,
      systemPrompt:
        '你是 AgentHub Orchestrator 编排下的子任务执行 Agent。\n\n' +
        '**输出要求**（必须严格遵守）：\n' +
        '1. 极度简洁，**不超过 250 字**（如必须给出完整代码文件，代码块本身不计入字数，但其它说明仍受限）。\n' +
        '2. 结论先行，去掉客套与重复。不要复述上游任务。\n' +
        '3. 代码块带 `path=` 文件路径，使用 unified diff（语言 `diff`）修改既有文件。\n' +
        '4. 中文回复，Markdown 格式。',
      messages: [{ role: 'user', content: userMsg }],
      budget: { maxTokens: 600 },
    };

    let output = '';
    let errored = false;
    try {
      for await (const ev of adapter.chat(req, ctrl.signal)) {
        switch (ev.type) {
          case 'token':
            output += ev.text;
            send({ op: 'msg_token', msgId, delta: ev.text });
            break;
          case 'thinking':
            send({ op: 'msg_thinking', msgId, delta: ev.text });
            break;
          case 'done':
            send({ op: 'msg_done', msgId, usage: ev.usage });
            break;
          case 'error':
            errored = true;
            send({ op: 'msg_error', msgId, error: ev.error });
            break;
        }
      }
    } finally {
      this.aborts.delete(task.id);
    }

    if (errored) {
      if (task.retries < MAX_RETRIES) {
        task.retries++;
        this.markTask(plan, task, 'ready', send);
        return;
      }
      this.markTask(plan, task, 'failed', send, { code: 'AGENT_ERROR', message: 'see chat' });
      return;
    }

    // Critic — for now always-pass placeholder.
    const verdict = await this.critic.judge(task, { artifactKind: 'text' });
    if (verdict.verdict === 'PASS') {
      task.artifactRefs = { messageId: msgId };
      task.finishedAt = new Date().toISOString();
      this.markTask(plan, task, 'succeeded', send);
    } else {
      this.markTask(plan, task, 'failed', send, {
        code: 'CRITIC_REJECTED',
        message: verdict.reasons.join('; '),
      });
    }
    void output;
  }

  private markTask(
    plan: Plan,
    task: PlanTask,
    status: TaskStatus,
    send: (e: ServerEvent) => void,
    error?: { code: string; message: string },
  ): void {
    task.status = status;
    if (error) task.error = error;
    plan.updatedAt = new Date().toISOString();
    plan.version++;
    void this.plans.save(plan);
    send({ op: 'plan_update', plan: snapshot(plan) });
  }
}

function isReady(task: PlanTask, byId: Map<string, PlanTask>): boolean {
  if (task.status !== 'pending' && task.status !== 'ready') return false;
  return task.inputs.every((u) => byId.get(u)?.status === 'succeeded');
}

function collectUpstream(task: PlanTask, plan: Plan): string {
  const lines: string[] = [];
  for (const id of task.inputs) {
    const up = plan.tasks.find((t) => t.id === id);
    if (up?.status === 'succeeded') {
      lines.push(`- ${up.id}（${up.goal}）：已完成`);
    }
  }
  return lines.join('\n');
}

/** Deep-clone a plan so subscribers don't see in-place mutations after the event. */
function snapshot(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan)) as Plan;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
