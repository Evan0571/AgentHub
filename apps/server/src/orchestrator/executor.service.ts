import { Inject, Injectable } from '@nestjs/common';
import type {
  AdapterErrorPayload,
  AdapterRegistry,
  AgentAdapter,
  ChatRequest,
  Message,
} from '@agenthub/adapter-core';
import type { Plan, PlanTask, ServerEvent, TaskStatus } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import { CriticService } from './critic.service.js';
import { PlanService } from './plan.service.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { AgentsRepo } from '../db/agents.repo.js';
import { ConversationsRepo } from '../db/conversations.repo.js';
import { AgentToolRunnerService } from '../workspace/agent-tool-runner.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { ProjectStateService } from '../workspace/project-state.service.js';
import { TeamWakeService } from './team-wake.service.js';

// Most conv-agents share one OpenAI key with a low TPM (e.g. 30k/min on
// gpt-4o trial orgs). Running 4 heavy tasks at once instantly blows the
// per-minute token budget → 429 → task failure. 2 keeps throughput while
// staying under typical limits; the Codex adapter also honors Retry-After.
const MAX_PARALLEL = Math.max(1, Number(process.env.AGENTHUB_MAX_PARALLEL ?? 2) || 2);
/** How many times we re-run the agent feeding back the REAL verification error. */
function maxVerifyAttempts(): number {
  const raw = Number(process.env.AGENTHUB_MAX_VERIFY_ATTEMPTS ?? 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(12, Math.trunc(raw)));
}
function maxToolRoundsPerAttempt(): number {
  const raw = Number(process.env.AGENTHUB_MAX_TOOL_ROUNDS ?? 80);
  if (!Number.isFinite(raw)) return 80;
  return Math.max(16, Math.min(200, Math.trunc(raw)));
}
function maxAgentStreamAttempts(): number {
  const raw = Number(process.env.AGENTHUB_MAX_AGENT_STREAM_ATTEMPTS ?? 3);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(6, Math.trunc(raw)));
}

interface ResolvedExecutorAgent {
  agentId: string;
  adapterId: string;
  name: string;
  systemPrompt: string;
  adapter: AgentAdapter;
}

@Injectable()
export class ExecutorService {
  private readonly aborts = new Map<string, AbortController>();
  private readonly runningPlans = new Set<string>();

  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly critic: CriticService,
    private readonly plans: PlanService,
    private readonly messages: MessagesRepo,
    private readonly agents: AgentsRepo,
    private readonly convs: ConversationsRepo,
    private readonly adapterFactory: AdapterFactoryService,
    private readonly toolRunner: AgentToolRunnerService,
    private readonly workspace: WorkspaceService,
    private readonly projectState: ProjectStateService,
    private readonly teamWake: TeamWakeService,
  ) {}

  /**
   * Topological execution with bounded parallelism.
   * Emits plan_update on every status transition + streams task output as
   * normal agent messages in the conversation.
   */
  async run(plan: Plan, send: (e: ServerEvent) => void): Promise<void> {
    if (this.runningPlans.has(plan.id)) {
      send({
        op: 'error',
        code: 'PLAN_ALREADY_RUNNING',
        message: `Plan ${plan.id} is already executing`,
        retryable: true,
      });
      return;
    }

    this.runningPlans.add(plan.id);
    try {
    plan.status = 'executing';
    await this.plans.save(plan);
    await this.workspace.syncTaskBoardFromPlan(plan.conversationId, plan).catch((error: unknown) => {
      console.error('[executor] failed to sync task board', error);
    });
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
    await this.workspace.syncTaskBoardFromPlan(plan.conversationId, plan).catch((error: unknown) => {
      console.error('[executor] failed to sync final task board', error);
    });
    send({ op: 'plan_update', plan: snapshot(plan) });
    } finally {
      this.runningPlans.delete(plan.id);
    }
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

    const assignee = await this.resolveAssignee(task.assigneeAgentId);
    const { adapter, agentId, adapterId } = assignee;
    task.assigneeAgentId = agentId;
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
        senderId: agentId,
        createdAt: new Date().toISOString(),
      },
    });

    // Prefix the agent reply with a task header so the chat is readable.
    const header = `### ${task.id} · ${task.goal}\n\n`;
    send({ op: 'msg_token', msgId, delta: header });

    const status = (line: string) =>
      send({ op: 'msg_thinking', msgId, delta: `\n${line}\n` });

    const upstreamContext = collectUpstream(task, plan);
    const recentMsgs = await this.messages.list(plan.conversationId).catch(() => []);
    const recentContext = formatRecentContext(recentMsgs, 10);
    const conversation = await this.convs.getById(plan.conversationId).catch(() => null);
    const teamRoster = renderTeamRoster(conversation?.members ?? []);
    const taskBoard = renderTaskBoard(plan, task.id);
    const projectDoc = await this.workspace
      .readFile(plan.conversationId, { path: 'PROJECT.md', maxBytes: 8_000 })
      .then((r) => r.content.trim())
      .catch(() => '');
    const teamMemoryDoc = await this.workspace
      .readFile(plan.conversationId, { path: 'TEAM_MEMORY.md', maxBytes: 8_000 })
      .then((r) => r.content.trim())
      .catch(() => '');
    await this.projectState.setGoalIfEmpty(plan.conversationId, plan.rootGoal);
    const pState = await this.projectState.load(plan.conversationId);
    const projectMemory = this.projectState.renderForPrompt(pState);
    const baseSystemPrompt =
      (assignee.systemPrompt
        ? `## 你的角色：${assignee.name}\n\n${assignee.systemPrompt.trim()}\n\n`
        : '') +
      (teamRoster ? `## 团队名册与交接规则\n\n${teamRoster}\n\n` : '') +
      (taskBoard ? `## 当前任务看板\n\n${taskBoard}\n\n` : '') +
      '你是 AgentHub 项目团队中的子任务执行 Agent，工作在一个真实的项目工作区里。\n\n' +
      '**工作方式（必须遵守）**：\n' +
      '1. 这是真实文件系统：用 workspace_write / workspace_write_many 把代码真正写进文件，不要只在聊天里贴代码。\n' +
      '2. 需要上游产物时，用 workspace_read / workspace_list 读**真实文件**，不要凭记忆猜上游的接口/路径。\n' +
      '3. **绝不允许半截或省略**：所有函数、事件处理、闭合标签都要写完整。不要写 "// 省略" / "其余同理"。\n' +
      '4. 写完后自己用 terminal_run 跑构建/类型检查验证；报错就继续修，直到通过。\n' +
      '5. **禁止占用 3000 / 4000 端口**（用户本机服务在用）；要起服务用 5173/8080 等其它端口，且优先用会退出的命令（npm run build / tsc）验证，不要长跑 dev server（npm run start / vite 常驻）。\n' +
      '6. 不要急、允许多轮迭代：先打通最小闭环再增强。改了会影响别人的东西（接口契约/文件结构/共享类型）要在回复里 @ 受影响角色对齐；需求不确定且代价大时 @ 用户问清楚再做。\n' +
      '7. 共享记忆：开始前优先读 PROJECT.md、TEAM_MEMORY.md 和任务相关真实文件；最终回答前必须做 memory review。改了共享契约、环境变量、数据模型、接口、验收口径、部署方式、角色交接或本地设置时，先用 memory_note 写入对应记忆层；没有持久事实变化就不要写。\n' +
      '8. 配置与外部依赖：需要用户提供 key/token/URL 时，写 `.env.example`，列出变量名、用途和是否必填。可以先实现本地 provider/mock，但必须明确隔离，不能把假数据伪装成真实能力。\n' +
      '9. Docker/数据库/缓存/队列：如果任务需要本地基础设施，创建或更新 `docker-compose.yml`、schema/migration/seed，并用 terminal_run 运行 `docker compose config` 或可退出的诊断命令；如果 Docker CLI/daemon 不可用，保留真实错误并说明用户要安装/启动什么。\n' +
      '10. 产品质量：前端必须贴合具体领域和用户工作流。不要蓝紫渐变 AI 模板、空卡片、占位 KPI、假图表；每个按钮/筛选/表格/图表都要有真实本地状态、数据流、错误态或明确 disabled 的下一步说明。\n' +
      '11. 输出克制：不要 emoji；不要写"我将/首先/接下来/总结/如需请告知"模板句；不要复述工具调用流水账。\n' +
      '12. 最终正文只写交付结果、关键文件、验证结果和下一步阻塞。任务没真正可运行前不要宣称完成。' +
      (projectMemory ? `\n\n${projectMemory}` : '') +
      (recentContext
        ? `\n\n## 最近对话（工作记忆，越靠下越新）\n\n${recentContext}\n\n` +
          `用户可能在过程中补充或修改了要求 —— 以最新的为准。`
        : '');

    const baseUserMsg =
      (conversation?.title ? `项目名称：${conversation.title}\n\n` : '') +
      (projectDoc ? `PROJECT.md 当前内容：\n${projectDoc}\n\n` : '') +
      (teamMemoryDoc ? `TEAM_MEMORY.md 当前内容：\n${teamMemoryDoc}\n\n` : '') +
      `任务目标：${task.goal}\n\n` +
      (upstreamContext ? `${upstreamContext}\n\n` : '') +
      `请在工作区里实现本任务（真实写文件 + 自测）。`;

    // The agent conversation. We re-enter it across verification rounds,
    // appending the REAL command failure each time so it self-corrects —
    // the workspace filesystem is the shared memory between rounds.
    const messages: Message[] = [{ role: 'user', content: baseUserMsg }];

    const baseReq = (): ChatRequest => ({
      taskId: task.id,
      metadata: {
        purpose: 'task',
        planId: plan.id,
        taskId: task.id,
        taskGoal: task.goal,
        conversationId: plan.conversationId,
        agentId,
        adapterId,
        agentName: assignee.name,
      },
      workspace: { id: plan.conversationId, snapshotId: 'head' },
      systemPrompt: baseSystemPrompt,
      messages,
      // No maxTokens cap: a real implementation task legitimately needs
      // thousands of tokens; capping it is what caused truncated/stub code.
    });

    const verify = await this.resolveVerification(plan.conversationId, task);
    const maxAttempts = maxVerifyAttempts();
    let output = '';
    let agentErrored = false;
    let lastAgentError: AdapterErrorPayload | undefined;
    let lastFailure: string | null = null;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          status(`第 ${attempt}/${maxAttempts} 轮：根据真实报错修复`);
        }

        for (let streamAttempt = 1; streamAttempt <= maxAgentStreamAttempts(); streamAttempt++) {
          const run = await this.toolRunner.run({
            adapter,
            request: baseReq(),
            conversationId: plan.conversationId,
            msgId,
            send,
            signal: ctrl.signal,
            maxToolRounds: maxToolRoundsPerAttempt(),
            // Keep the message in streaming state across all verification
            // rounds so the live activity feed stays visible (not collapsed
            // to a "done" thinking block mid-task). We emit the single final
            // msg_done ourselves below.
            suppressDone: true,
            suppressRetryableErrors: true,
          });
          output = run.output || output;
          agentErrored = run.errored;
          lastAgentError = run.error;

          if (!agentErrored) break;
          if (ctrl.signal.aborted || !isRetryableAgentError(lastAgentError) || streamAttempt >= maxAgentStreamAttempts()) {
            break;
          }
          status(
            `Agent stream interrupted (${lastAgentError?.code ?? 'ERROR'}); retrying ${streamAttempt + 1}/${maxAgentStreamAttempts()}`,
          );
          await sleep(600 * streamAttempt);
        }

        if (agentErrored) {
          if (lastAgentError) {
            send({ op: 'msg_error', msgId, error: lastAgentError });
          }
          break;
        }

        if (!verify) {
          // Nothing mechanically verifiable (static HTML, docs, manual).
          // Fall back to the lenient, now-timeout-guarded critic LLM.
          status('无可机检命令，进行轻量审查');
          const verdict = await this.critic.judge(task, output);
          if (verdict.verdict === 'PASS') {
            lastFailure = null;
            break;
          }
          lastFailure = verdict.reasons.join('；') || 'Critic 判定未达标';
          if (attempt >= maxAttempts) break;
          messages.push({ role: 'assistant', content: output });
          messages.push({
            role: 'user',
            content: `审查未通过：${lastFailure}\n请直接修正（继续写文件），不要解释。`,
          });
          continue;
        }

        // ---- real verification ----
        const result = await this.runVerification(plan.conversationId, verify, status);
        if (result.ok) {
          lastFailure = null;
          status(`验证通过：${verify.label}`);
          break;
        }

        lastFailure = result.detail;
        if (attempt >= maxAttempts) break;
        messages.push({ role: 'assistant', content: output || '(无文本输出)' });
        messages.push({
          role: 'user',
          content:
            `验证未通过。命令：\`${result.command}\`，退出码 ${result.exitCode}。\n\n` +
            `真实输出（节选）：\n\`\`\`\n${result.detail}\n\`\`\`\n\n` +
            `请直接定位并修复（用 workspace_read 看真实文件、workspace_write 改），改完会再次自动验证。不要只解释。`,
        });
      }
    } finally {
      this.aborts.delete(task.id);
    }

    task.outputText = output;
    void this.messages
      .insert({
        conversationSlug: plan.conversationId,
        senderType: 'agent',
        senderId: agentId,
        text: header + output,
      })
      .catch(() => undefined);

    // Single terminal msg_done for the whole task (all verification rounds).
    // toolRunner ran with suppressDone:true so the message stayed streaming
    // and the live activity feed was visible the entire time.
    send({ op: 'msg_done', msgId });
    await this.teamWake.processPending(plan.conversationId, send, {
      reason: `task handoff after ${task.id}`,
      maxItems: 3,
    });

    if (agentErrored) {
      void this.projectState.recordOutcome(plan.conversationId, {
        kind: 'blocked',
        taskId: task.id,
        goal: task.goal,
        note: '执行 Agent 报错',
      });
      this.markTask(plan, task, 'failed', send, {
        code: lastAgentError?.code ?? 'AGENT_ERROR',
        message: lastAgentError
          ? `${lastAgentError.message} (automatic stream retries exhausted)`
          : 'Agent execution failed; see the chat message above.',
      });
      return;
    }

    if (lastFailure) {
      status(`用尽 ${maxAttempts} 轮仍未通过验证，任务失败。`);
      void this.projectState.recordOutcome(plan.conversationId, {
        kind: 'blocked',
        taskId: task.id,
        goal: task.goal,
        note: lastFailure.slice(0, 160),
      });
      this.markTask(plan, task, 'failed', send, {
        code: 'VERIFY_FAILED',
        message: lastFailure.slice(0, 500),
      });
      return;
    }

    void this.projectState.recordOutcome(plan.conversationId, {
      kind: 'done',
      taskId: task.id,
      goal: task.goal,
    });
    task.artifactRefs = { messageId: msgId };
    task.finishedAt = new Date().toISOString();
    task.criticFeedback = undefined;
    this.markTask(plan, task, 'succeeded', send);
  }

  /**
   * Decide HOW to mechanically verify a task. Reads the real workspace
   * (package.json / tsconfig) so verification matches the actual project.
   * Returns null when there is nothing to compile (static HTML, docs) —
   * the caller then falls back to the lenient critic.
   */
  private async resolveVerification(
    conversationId: string,
    task: PlanTask,
  ): Promise<{ setup: string | null; verify: string; label: string } | null> {
    // Explicit test command on the acceptance rule wins.
    const testRule = task.acceptance.find(
      (a): a is { kind: 'test'; cmd: string } => a.kind === 'test' && typeof (a as { cmd?: unknown }).cmd === 'string',
    );

    let pkg: { scripts?: Record<string, string> } | null = null;
    try {
      const read = await this.workspace.readFile(conversationId, { path: 'package.json', maxBytes: 64_000 });
      pkg = JSON.parse(read.content) as { scripts?: Record<string, string> };
    } catch {
      pkg = null;
    }
    let hasTsconfig = false;
    try {
      await this.workspace.readFile(conversationId, { path: 'tsconfig.json', maxBytes: 8_000 });
      hasTsconfig = true;
    } catch {
      hasTsconfig = false;
    }

    const setup = pkg ? 'npm install --no-audit --no-fund --loglevel=error' : null;
    const scripts = pkg?.scripts ?? {};

    if (testRule) return { setup, verify: testRule.cmd, label: testRule.cmd };
    if (scripts.build) return { setup, verify: 'npm run build', label: 'npm run build' };
    if (scripts.typecheck) return { setup, verify: 'npm run typecheck', label: 'npm run typecheck' };
    if (scripts.lint) return { setup, verify: 'npm run lint', label: 'npm run lint' };
    if (hasTsconfig) return { setup, verify: 'npx --yes tsc --noEmit', label: 'tsc --noEmit' };
    return null;
  }

  /** Run setup (once-ish) + the verify command; return ok + trimmed real output. */
  private async runVerification(
    conversationId: string,
    plan: { setup: string | null; verify: string; label: string },
    status: (line: string) => void,
  ): Promise<{ ok: true } | { ok: false; command: string; exitCode: number | null; detail: string }> {
    if (plan.setup) {
      status(`安装依赖：${plan.setup}`);
      const dep = await this.workspace.runCommand(conversationId, {
        command: plan.setup,
        timeoutMs: 600_000,
      });
      if (dep.exitCode !== 0 && !dep.timedOut) {
        return {
          ok: false,
          command: plan.setup,
          exitCode: dep.exitCode,
          detail: tail(`${dep.stdout}\n${dep.stderr}`, 2500),
        };
      }
    }

    status(`验证：${plan.label}`);
    const res = await this.workspace.runCommand(conversationId, {
      command: plan.verify,
      timeoutMs: 300_000,
    });
    if (res.exitCode === 0 && !res.timedOut) return { ok: true };
    return {
      ok: false,
      command: plan.verify,
      exitCode: res.timedOut ? null : res.exitCode,
      detail: res.timedOut
        ? `命令超时（>5min）。\n${tail(`${res.stdout}\n${res.stderr}`, 1500)}`
        : tail(`${res.stdout}\n${res.stderr}`, 2500),
    };
  }


  private async resolveAssignee(preferred?: string): Promise<ResolvedExecutorAgent> {
    if (preferred) {
      const agent = await this.agents.getByIdWithSecrets(preferred);
      if (agent) {
        const adapter = this.adapterFactory.resolveForAgent({
          agentId: agent.id,
          adapterId: agent.adapterId,
          model: agent.model,
          apiKey: agent.apiKey,
          baseUrl: agent.baseUrl,
        });
        return {
          agentId: agent.id,
          adapterId: agent.adapterId,
          name: agent.name,
          systemPrompt: agent.systemPrompt ?? '',
          adapter,
        };
      }

      if (this.registry.has(preferred)) {
        return {
          agentId: preferred,
          adapterId: preferred,
          name: preferred,
          systemPrompt: '',
          adapter: this.registry.get(preferred),
        };
      }
    }

    const fallback = this.fallbackAdapterId();
    return {
      agentId: fallback,
      adapterId: fallback,
      name: fallback,
      systemPrompt: '',
      adapter: this.registry.get(fallback),
    };
  }

  private fallbackAdapterId(): string {
    for (const id of ['codex', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3', 'deepseek-r1', 'mock']) {
      if (this.registry.has(id)) return id;
    }
    return 'mock';
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
    else if (status !== 'failed') task.error = undefined;
    plan.updatedAt = new Date().toISOString();
    plan.version++;
    void this.plans.save(plan);
    void this.workspace.syncTaskBoardFromPlan(plan.conversationId, plan).catch((syncError: unknown) => {
      console.error('[executor] failed to sync task board', syncError);
    });
    send({ op: 'plan_update', plan: snapshot(plan) });
  }
}

function isReady(task: PlanTask, byId: Map<string, PlanTask>): boolean {
  if (task.status !== 'pending' && task.status !== 'ready') return false;
  return task.inputs.every((u) => byId.get(u)?.status === 'succeeded');
}

function isRetryableAgentError(error: AdapterErrorPayload | undefined): boolean {
  if (!error) return false;
  return error.retryable || (error.code === 'CANCELLED' && /aborted/i.test(error.message));
}

/**
 * Upstream context for a downstream task. We DON'T paste truncated upstream
 * code (that made agents build against phantom stubs). The real files live in
 * the shared workspace — so we just tell the agent which tasks finished and a
 * one-line gist, and instruct it to `workspace_read` the actual files.
 */
/** Compact transcript of the last N messages — conversation working memory. */
function formatRecentContext(
  msgs: Array<{ senderType: string; senderId: string; text: string }>,
  limit: number,
): string {
  if (msgs.length === 0) return '';
  return msgs
    .slice(-limit)
    .map((m) => {
      const who = m.senderType === 'user' ? '用户' : m.senderType === 'system' ? '系统' : m.senderId;
      const t = m.text.replace(/```[\s\S]*?```/g, ' [代码块] ').replace(/\s+/g, ' ').trim();
      return `[${who}] ${t.length > 240 ? t.slice(0, 240) + '…' : t}`;
    })
    .join('\n');
}

function collectUpstream(task: PlanTask, plan: Plan): string {
  const parts: string[] = [];
  for (const id of task.inputs) {
    const up = plan.tasks.find((t) => t.id === id);
    if (!up || up.status !== 'succeeded') continue;
    parts.push(`- ${up.id} · ${up.goal}：${gist(up.outputText)}`);
  }
  if (parts.length === 0) return '';
  return (
    `已完成的上游任务（产物已在工作区，需要时用 workspace_list / workspace_read 看真实文件，不要凭记忆猜）：\n` +
    parts.join('\n')
  );
}

function renderTeamRoster(
  members: Array<{
    agentId: string;
    name: string;
    adapterId: string;
    systemPrompt?: string | null;
  }>,
): string {
  const visible = members.filter((m) => m.agentId !== 'orchestrator' && m.agentId !== 'mock');
  if (visible.length === 0) return '';
  const lines = visible.map((member) => {
    const role = summarizeRole(member.systemPrompt) || member.adapterId;
    return `- ${member.name} (@${shortAgentId(member.agentId)}): ${role}`;
  });
  return [
    lines.join('\n'),
    '',
    '交接规则：改共享接口、文件结构、数据模型、验证命令、环境变量或部署方式时，点名受影响角色并说明变化；把持久结论写入 TEAM_MEMORY.md；遇到阻塞要写清事实、失败命令和下一位成员需要接手的内容。',
  ].join('\n');
}

function renderTaskBoard(plan: Plan, currentTaskId: string): string {
  const lines = plan.tasks.slice(0, 16).map((item) => {
    const current = item.id === currentTaskId ? ' current' : '';
    const owner = item.assigneeAgentId ? `@${shortAgentId(item.assigneeAgentId)}` : 'unassigned';
    const deps = item.inputs.length > 0 ? ` after ${item.inputs.join(',')}` : '';
    return `- ${item.id}${current} [${item.status}] ${owner}${deps}: ${item.goal}`;
  });
  const hidden = plan.tasks.length > lines.length ? `\n- ... ${plan.tasks.length - lines.length} more tasks hidden` : '';
  return `${lines.join('\n')}${hidden}`;
}

/** One-line gist of an upstream reply (no code dump). */
function gist(text: string | undefined): string {
  if (!text) return '（无说明）';
  const prose = text.replace(/```[\s\S]*?```/g, ' [代码已写入工作区] ').replace(/\s+/g, ' ').trim();
  return prose.length > 160 ? prose.slice(0, 160) + '…' : prose || '（产物已写入工作区）';
}

/** Keep the LAST n chars — build errors put the actionable part at the end. */
function tail(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
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

function summarizeRole(systemPrompt: string | null | undefined): string {
  if (!systemPrompt) return '';
  return systemPrompt
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function shortAgentId(agentId: string): string {
  const match = /^conv-agent-[0-9a-fA-F-]{36}-(.+)$/.exec(agentId);
  return match?.[1] ?? agentId;
}
