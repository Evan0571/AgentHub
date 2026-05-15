import { Inject, Injectable } from '@nestjs/common';
import type { ClientEvent, ServerEvent, Plan } from '@agenthub/shared-types';
import type { AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import { PlannerService } from './planner.service.js';
import { ExecutorService } from './executor.service.js';
import { PlanService } from './plan.service.js';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { TracingService } from '../observability/tracing.service.js';

/**
 * Public-facing orchestrator (PRD §5.5).
 * Other modules talk to this; sub-services (planner / executor / critic / replanner)
 * are internal.
 */
@Injectable()
export class OrchestratorService {
  constructor(
    private readonly planner: PlannerService,
    private readonly executor: ExecutorService,
    private readonly plans: PlanService,
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly messages: MessagesRepo,
    private readonly tracing: TracingService,
  ) {}

  async plan(
    input: { conversationId: string; rootGoal: string },
    send: (e: ServerEvent) => void,
  ): Promise<Plan> {
    return this.tracing.runWithTrace(
      {
        name: 'orchestrator.plan',
        sessionId: input.conversationId,
        metadata: {
          conversationId: input.conversationId,
          rootGoal: input.rootGoal,
        },
      },
      () => this.planImpl(input, send),
    );
  }

  private async planImpl(
    input: { conversationId: string; rootGoal: string },
    send: (e: ServerEvent) => void,
  ): Promise<Plan> {
    const planningMsgId = cryptoRandomId();
    const plannerAgent = await this.planner.getPlannerProfile(input.conversationId);
    const intro = `🧭 ${plannerAgent ? `${plannerAgent.name} 正在做架构规划` : '正在拆解目标'}：\n\n> ${input.rootGoal}\n\n_调用${plannerAgent ? '项目架构师' : ' Planner 模型'}中…_`;
    send({
      op: 'msg_started',
      message: {
        id: planningMsgId,
        conversationId: input.conversationId,
        senderType: plannerAgent ? 'agent' : 'system',
        senderId: plannerAgent?.agentId ?? 'orchestrator',
        createdAt: new Date().toISOString(),
      },
    });
    send({ op: 'msg_token', msgId: planningMsgId, delta: intro });

    // Hard timeout — if the planner LLM hangs, don't leave the chat stuck on
    // "正在拆解…" forever. 60s is generous for DeepSeek V3 streaming.
    let plan: Plan;
    try {
      plan = await Promise.race([
        this.planner.draft(input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('planner timeout (60s)')), 60_000),
        ),
      ]);
    } catch (e) {
      const errMsg = (e as Error).message;
      console.error('[orchestrator] planner failed:', errMsg);
      const failText = `\n\n❌ Plan 拆解失败：${errMsg}\n\n请重试，或检查 server 控制台日志。`;
      send({ op: 'msg_token', msgId: planningMsgId, delta: failText });
      send({ op: 'msg_done', msgId: planningMsgId });
      void this.messages
        .insert({
          conversationSlug: input.conversationId,
          senderType: plannerAgent ? 'agent' : 'system',
          senderId: plannerAgent?.agentId ?? 'orchestrator',
          text: intro + failText,
        })
        .catch(() => undefined);
      throw e;
    }

    await this.plans.save(plan);

    const summary = `\n\n✅ 已生成 **${plan.tasks.length}** 个子任务（见右侧 Plan 面板）。开始并发执行 →`;
    send({ op: 'msg_token', msgId: planningMsgId, delta: summary });
    send({ op: 'msg_done', msgId: planningMsgId });

    void this.messages
      .insert({
        conversationSlug: input.conversationId,
        senderType: plannerAgent ? 'agent' : 'system',
        senderId: plannerAgent?.agentId ?? 'orchestrator',
        text: intro + summary,
      })
      .catch(() => undefined);

    send({ op: 'plan_update', plan });
    void this.executor.run(plan, send);
    return plan;
  }

  async cancel(taskId: string): Promise<void> {
    await this.executor.cancel(taskId);
  }

  async pause(planId: string): Promise<void> {
    await this.plans.setStatus(planId, 'paused');
  }

  async resume(planId: string): Promise<void> {
    await this.plans.setStatus(planId, 'executing');
  }

  async applyPlanEdits(
    event: Extract<ClientEvent, { op: 'edit_plan' }>,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    const result = await this.plans.applyEdits(event.planId, event.edits, event.baseVersion);
    if (result.kind === 'conflict') {
      send({
        op: 'plan_conflict',
        planId: event.planId,
        serverVersion: result.serverVersion,
        clientVersion: event.baseVersion,
      });
      return;
    }
    send({ op: 'plan_update', plan: result.plan });

    // If the edit produced executable work (newly-added tasks, or formerly-failed
    // ones now retryable) and the plan isn't already running, resume execution.
    const hasWork = result.plan.tasks.some(
      (t) => t.status === 'pending' || t.status === 'ready',
    );
    if (hasWork && result.plan.status !== 'executing') {
      void this.executor.run(result.plan, send);
    }
  }

  /**
   * AI-assisted dependency suggestion for a new task being authored.
   * Sends `dep_suggestion` (or `dep_suggestion_error`) keyed by requestId.
   */
  async suggestDeps(
    event: Extract<ClientEvent, { op: 'suggest_deps' }>,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    return this.tracing.runWithTrace(
      {
        name: 'orchestrator.suggest_deps',
        metadata: { planId: event.planId, newGoal: event.newGoal },
      },
      () => this.suggestDepsImpl(event, send),
    );
  }

  private async suggestDepsImpl(
    event: Extract<ClientEvent, { op: 'suggest_deps' }>,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    const plan = await this.plans.get(event.planId);
    if (!plan) {
      send({
        op: 'dep_suggestion_error',
        planId: event.planId,
        requestId: event.requestId,
        message: 'plan not found',
      });
      return;
    }

    const adapter = this.registry.has('deepseek-v3')
      ? this.registry.get('deepseek-v3')
      : this.registry.has('mock')
        ? this.registry.get('mock')
        : undefined;
    if (!adapter) {
      send({
        op: 'dep_suggestion_error',
        planId: event.planId,
        requestId: event.requestId,
        message: 'no adapter available',
      });
      return;
    }

    const taskList = plan.tasks
      .map((t) => `- ${t.id}: ${t.goal}`)
      .join('\n');
    const userMsg =
      `已有任务清单：\n${taskList || '(空)'}\n\n` +
      `新任务的目标：\n${event.newGoal}\n\n` +
      `请输出该新任务的前置依赖（input task ids）。`;

    const req: ChatRequest = {
      taskId: 'suggest-' + event.requestId,
      metadata: { purpose: 'suggest_deps', planId: event.planId },
      systemPrompt:
        '你是 AgentHub 的 Plan 助手。根据用户描述的新任务目标和现有任务列表，' +
        '判断该新任务的前置依赖。\n\n' +
        '**判断原则**：\n' +
        '- 若新任务需要使用上游任务的产出（如"实现 App"依赖"实现 TodoList"），则把上游列为依赖。\n' +
        '- 若新任务是入口/初始化类（"初始化项目"、"选型"），通常无依赖。\n' +
        '- "联调 / 测试 / 部署 / 写文档"类通常依赖所有实现类任务。\n\n' +
        '**严格输出 JSON**（无任何额外文字），格式：\n' +
        '{"suggestedInputs":["T2","T3"],"reasoning":"一句话说明"}\n' +
        '若无依赖：{"suggestedInputs":[],"reasoning":"入口任务"}',
      messages: [{ role: 'user', content: userMsg }],
      budget: { maxTokens: 200 },
    };

    let raw = '';
    try {
      for await (const ev of adapter.chat(req)) {
        if (ev.type === 'token') raw += ev.text;
        if (ev.type === 'error') {
          send({
            op: 'dep_suggestion_error',
            planId: event.planId,
            requestId: event.requestId,
            message: ev.error.message,
          });
          return;
        }
      }
    } catch (e) {
      send({
        op: 'dep_suggestion_error',
        planId: event.planId,
        requestId: event.requestId,
        message: String(e),
      });
      return;
    }

    const parsed = extractJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.suggestedInputs)) {
      send({
        op: 'dep_suggestion_error',
        planId: event.planId,
        requestId: event.requestId,
        message: 'could not parse suggestion JSON',
      });
      return;
    }

    const validIds = new Set(plan.tasks.map((t) => t.id));
    const cleaned = parsed.suggestedInputs.filter(
      (x): x is string => typeof x === 'string' && validIds.has(x),
    );
    send({
      op: 'dep_suggestion',
      planId: event.planId,
      requestId: event.requestId,
      suggestedInputs: cleaned,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
    });
  }
}

function extractJsonObject(text: string): { suggestedInputs?: unknown; reasoning?: unknown } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
