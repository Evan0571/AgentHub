import { Injectable } from '@nestjs/common';
import type { ClientEvent, ServerEvent, Plan } from '@agenthub/shared-types';
import { PlannerService } from './planner.service.js';
import { ExecutorService } from './executor.service.js';
import { PlanService } from './plan.service.js';

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
  ) {}

  async plan(
    input: { conversationId: string; rootGoal: string },
    send: (e: ServerEvent) => void,
  ): Promise<Plan> {
    // Surface "planning" feedback in the chat so the user has something to look at
    // while the LLM is composing the DAG.
    const planningMsgId = cryptoRandomId();
    send({
      op: 'msg_started',
      message: {
        id: planningMsgId,
        conversationId: input.conversationId,
        senderType: 'system',
        senderId: 'orchestrator',
        createdAt: new Date().toISOString(),
      },
    });
    send({
      op: 'msg_token',
      msgId: planningMsgId,
      delta: `🧭 **Orchestrator** 正在为目标拆解任务：\n> ${input.rootGoal}\n`,
    });

    const plan = await this.planner.draft(input);
    await this.plans.save(plan);

    send({
      op: 'msg_token',
      msgId: planningMsgId,
      delta:
        `\n已生成 **${plan.tasks.length}** 个子任务（见右侧 Plan 面板）。开始并发执行 →`,
    });
    send({ op: 'msg_done', msgId: planningMsgId });

    send({ op: 'plan_update', plan });
    void this.executor.run(plan, send); // fire-and-forget; updates streamed
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
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
