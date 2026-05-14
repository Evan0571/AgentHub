import { Inject, Injectable } from '@nestjs/common';
import type { AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { Plan, PlanTask, ServerEvent, TaskStatus } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { CriticService } from './critic.service.js';
import { PlanService } from './plan.service.js';
import { MessagesRepo } from '../db/messages.repo.js';

const MAX_PARALLEL = 5;
const MAX_RETRIES = 1;

@Injectable()
export class ExecutorService {
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly critic: CriticService,
    private readonly plans: PlanService,
    private readonly messages: MessagesRepo,
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
    const retryNote = task.criticFeedback
      ? `⚠️ **前一次输出被 Critic 拒绝**，原因：\n${task.criticFeedback}\n\n请直接修正这些问题后重新输出（不要解释你之前为什么不对）。\n\n`
      : '';
    const userMsg =
      retryNote +
      `任务目标：${task.goal}\n\n` +
      (upstreamContext ? `上游任务（已完成）：\n${upstreamContext}\n\n` : '') +
      `产出本任务的最终结果。如涉及代码，按 \`\`\`lang path=... 给出。`;

    const req: ChatRequest = {
      taskId: task.id,
      metadata: {
        purpose: 'task',
        planId: plan.id,
        taskId: task.id,
        taskGoal: task.goal,
        conversationId: plan.conversationId,
      },
      systemPrompt:
        '你是 AgentHub Orchestrator 编排下的子任务执行 Agent。\n\n' +
        '**输出要求**（必须严格遵守）：\n' +
        '1. 说明性文字极度简洁（≤ 250 字）；代码块本身不计入字数。\n' +
        '2. 结论先行，去掉客套与重复。不要复述上游任务。\n' +
        '3. 代码块带 `path=` 文件路径；使用 unified diff（语言 `diff`）修改既有文件。\n' +
        '4. **代码必须完整可运行**：所有函数实现都要写完，所有 DOM 监听 / 事件处理 / 闭合标签都不能省。\n' +
        '   代码块末尾必须用三个反引号收尾，绝不能截断在函数中间或语句中间。\n' +
        '   宁可多分几个 code block，也不能输出半截 — 半截代码会让 preview / deploy 出来的产物无法运行。\n' +
        '5. 中文回复，Markdown 格式。',
      messages: [{ role: 'user', content: userMsg }],
      // HTML/Vue/Vite 项目动辄 2000+ 完整 token；3000 留足余量避免截断。
      // 截断的代码块缺闭合 ``` → 前端按钮无 handler / React 组件半截。
      budget: { maxTokens: 3000 },
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

    // Capture the agent's output for downstream tasks. This is what lets
    // a later "App.tsx" task actually know the signature/path of components
    // produced upstream — without it the agent guesses (CRA boilerplate).
    task.outputText = output;

    // Persist the assembled agent message (with task header) for hydration.
    void this.messages
      .insert({
        conversationSlug: plan.conversationId,
        senderType: 'agent',
        senderId: adapterId,
        text: header + output,
      })
      .catch(() => undefined);

    // ---- Critic gate -----------------------------------------------------
    this.markTask(plan, task, 'awaiting-critic', send);
    const verdict = await this.critic.judge(task, output);

    if (verdict.verdict === 'PASS') {
      task.artifactRefs = { messageId: msgId };
      task.finishedAt = new Date().toISOString();
      // Clear any prior critic feedback once we've passed.
      task.criticFeedback = undefined;
      this.markTask(plan, task, 'succeeded', send);
      return;
    }

    // FAIL — surface to chat so the user sees the gate decision in context.
    const reasonsText = verdict.reasons.join('；') || '未提供具体原因';
    this.emitCriticMessage(plan.conversationId, task, verdict, send);

    if (task.retries < MAX_RETRIES) {
      task.retries++;
      task.criticFeedback = reasonsText +
        (verdict.suggestedReplan ? `\n建议：${verdict.suggestedReplan.hint}` : '');
      // Re-queue this task; the executor loop will pick it up again and the
      // retryNote in userMsg will tell the agent to self-correct.
      this.markTask(plan, task, 'ready', send);
      return;
    }

    // Out of retries.
    this.markTask(plan, task, 'failed', send, {
      code: 'CRITIC_REJECTED',
      message: reasonsText,
    });
  }

  /** Post a system-style "🧐 Critic" message in the conversation. */
  private emitCriticMessage(
    conversationId: string,
    task: PlanTask,
    verdict: { reasons: string[]; suggestedReplan?: { scope: string; hint: string } },
    send: (e: ServerEvent) => void,
  ): void {
    const msgId = cryptoRandomId();
    send({
      op: 'msg_started',
      message: {
        id: msgId,
        conversationId,
        senderType: 'system',
        senderId: 'orchestrator',
        createdAt: new Date().toISOString(),
      },
    });
    const lines = [
      `🧐 **Critic** 标记 **${task.id}** 为 FAIL`,
      ...verdict.reasons.map((r) => `- ${r}`),
    ];
    if (verdict.suggestedReplan) {
      lines.push(`_建议（${verdict.suggestedReplan.scope}）：${verdict.suggestedReplan.hint}_`);
    }
    if (task.retries < MAX_RETRIES) {
      lines.push(`\n将自动重试一次（携带反馈给 Agent 修正）→`);
    } else {
      lines.push(`\n已达重试上限，任务最终失败。`);
    }
    const text = lines.join('\n');
    send({ op: 'msg_token', msgId, delta: text });
    send({ op: 'msg_done', msgId });
    void this.messages
      .insert({
        conversationSlug: conversationId,
        senderType: 'system',
        senderId: 'orchestrator',
        text,
      })
      .catch(() => undefined);
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

/**
 * Build the upstream context for a downstream task.
 *
 * The hard problem: feed the next agent enough information to know what each
 * predecessor produced (file paths, exports, prop signatures) WITHOUT
 * exploding the context window. So we extract just the head of each code
 * block (imports + type/interface declarations + the function signature) and
 * truncate prose to a short summary.
 */
function collectUpstream(task: PlanTask, plan: Plan): string {
  const parts: string[] = [];
  for (const id of task.inputs) {
    const up = plan.tasks.find((t) => t.id === id);
    if (!up || up.status !== 'succeeded') continue;
    const body = up.outputText
      ? summarizeUpstreamOutput(up.outputText)
      : '_(无输出文本)_';
    parts.push(`### ${up.id} · ${up.goal}\n\n${body}`);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * For an upstream task's full reply, emit:
 *  - every code block, but only the first N lines of each (imports + types +
 *    signature, which is what downstream code needs to import/use it)
 *  - if no code blocks, a short prose excerpt
 */
function summarizeUpstreamOutput(text: string): string {
  const HEAD_LINES = 14;
  const blocks: string[] = [];
  const fenceRe = /```([\w-]+)([^\n]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const lang = match[1] ?? '';
    const meta = (match[2] ?? '').trim();
    const code = match[3] ?? '';
    const lines = code.split('\n');
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const truncated = lines.length > HEAD_LINES;
    blocks.push(
      '```' + lang + (meta ? ' ' + meta : '') + '\n' + head +
        (truncated ? `\n// … (省略 ${lines.length - HEAD_LINES} 行实现)\n` : '\n') + '```',
    );
  }
  if (blocks.length === 0) {
    // No code — keep the first 300 chars of narrative.
    return text.length > 300 ? text.slice(0, 300) + '…' : text;
  }
  return blocks.join('\n\n');
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
