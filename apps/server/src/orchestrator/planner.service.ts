import { Inject, Injectable } from '@nestjs/common';
import type { AdapterRegistry, AgentAdapter, ChatRequest } from '@agenthub/adapter-core';
import type { Plan, PlanTask, AcceptanceRule } from '@agenthub/shared-types';
import { planner as plannerPrompt } from '@agenthub/prompts';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import { AgentsRepo } from '../db/agents.repo.js';
import { ConversationsRepo } from '../db/conversations.repo.js';

interface RawTask {
  id?: string;
  goal?: string;
  details?: string;
  deliverables?: string[];
  checklist?: string[];
  inputs?: string[];
  acceptance?: AcceptanceRule[];
  candidateAgents?: string[];
}

interface RawPlan {
  rootGoal?: string;
  tasks?: RawTask[];
}

export interface PlannerAgentProfile {
  agentId: string;
  adapterId: string;
  name: string;
  systemPrompt: string;
}

interface ResolvedPlannerAgent extends PlannerAgentProfile {
  adapter: AgentAdapter;
}

@Injectable()
export class PlannerService {
  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly convs: ConversationsRepo,
    private readonly agents: AgentsRepo,
    private readonly adapterFactory: AdapterFactoryService,
  ) {}

  /**
   * Draft an initial DAG from a root goal using a Planner LLM.
   * Falls back to a canned 4-task plan when the LLM is unavailable or its
   * output cannot be parsed.
   */
  async draft(input: { conversationId: string; rootGoal: string }): Promise<Plan> {
    const catalog = await this.agentCatalog(input.conversationId);
    const plannerAgent = await this.resolvePlannerAgent(input.conversationId);
    const adapter = plannerAgent?.adapter ?? this.pickAdapter();
    if (!adapter) return this.cannedPlan(input, catalog.ids);

    const userMsg =
      `根目标：${input.rootGoal}\n\n` +
      `可用 Agent（必须从这些 id 里选 candidateAgents，禁止编造其它 id）：\n` +
      catalog.text +
      `\n\n` +
      `要求：\n` +
      `- 任务要**针对这个具体项目**拆解（用到项目里的真实功能/模块名），不要输出"定义产品目标""设计文件结构"这种放之四海皆准的空壳。\n` +
      `- 先 MVP 再扩展：第一批任务交付一个能跑起来的最小闭环，后续任务再加增强功能，不要一个任务想做完所有事。\n` +
      `- **全员覆盖**：上面列出的每一个 agent（组长 team-lead 除外）都必须**至少被分配到 1 个任务**（写进它的 candidateAgents）。不要让任何成员闲置——前端/后端/测试/审查/环境/产品/资深用户/风险审视都要有活干，必要时为某个角色单开一个任务（如测试员→写并跑测试，风险审视员→安全/边界审查，资深用户→可用性走查）。\n` +
      `- **允许迭代**：这个项目通常一轮做不完。可以规划"第一轮 MVP → 验证 → 第二轮增强 → 再验证"这样的多阶段任务（用 inputs 表达依赖），不要假设一次就交付完整成品。\n` +
      `- 每个任务的 candidateAgents 必须来自上面的 id 列表。\n` +
      `- 只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字。`;

    let raw = '';
    try {
      const req: ChatRequest = {
        taskId: 'planner-' + Date.now(),
        metadata: {
          purpose: 'planner',
          conversationId: input.conversationId,
          plannerAgentId: plannerAgent?.agentId,
          plannerAgentName: plannerAgent?.name,
        },
        systemPrompt: [
          plannerAgent
            ? `你现在以「${plannerAgent.name}」身份负责本项目的架构规划。\n\n${plannerAgent.systemPrompt}`.trim()
            : '',
          plannerPrompt.systemPrompt,
        ].filter(Boolean).join('\n\n'),
        messages: [{ role: 'user', content: userMsg }],
        // 800 was the bug: a real plan (details/deliverables/checklist for
        // several tasks) is easily 2k+ tokens → JSON truncated → extractJson
        // fails → cannedPlan every time (the identical T1-T5 the user saw).
        budget: { maxTokens: 4000 },
      };
      for await (const ev of adapter.chat(req)) {
        if (ev.type === 'token') raw += ev.text;
        if (ev.type === 'error') {
          console.error('[planner] adapter error', ev.error);
          break;
        }
      }
    } catch (e) {
      console.error('[planner] adapter threw', e);
      return this.cannedPlan(input, catalog.ids);
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      console.warn('[planner] could not parse JSON; falling back. raw=', raw.slice(0, 200));
      return this.cannedPlan(input, catalog.ids);
    }

    return this.normalize(parsed, input, catalog.ids);
  }

  /**
   * Lightweight intent triage done by the architect BEFORE auto-planning.
   *   - 'plan'     : a whole project / large change → decompose into a DAG.
   *   - 'dispatch' : a small/scoped change → hand straight to specific
   *                  engineers (targets = conversation member agentIds).
   * Fail-open to 'plan' so a triage hiccup never silently drops the request.
   */
  async triage(input: {
    conversationId: string;
    text: string;
    recentContext: string;
  }): Promise<{ mode: 'plan' | 'dispatch'; targets: string[]; brief: string }> {
    const fallback = { mode: 'plan' as const, targets: [] as string[], brief: input.text };
    const catalog = await this.agentCatalog(input.conversationId);
    const memberIds = [...catalog.ids].filter((id) => id !== 'orchestrator' && id !== 'mock');
    if (memberIds.length === 0) return fallback;

    const plannerAgent = await this.resolvePlannerAgent(input.conversationId);
    const adapter = plannerAgent?.adapter ?? this.pickAdapter();
    if (!adapter) return fallback;

    const sys =
      `你是项目组长（团队调度大脑），负责"分流"用户消息。只输出一个 JSON，无任何解释、无 markdown 围栏。\n\n` +
      `判定规则：\n` +
      `- 用户要"做一个完整项目 / 从零搭建 / 全栈 / 大重构 / 多模块" → mode="plan"。\n` +
      `- 用户是"小改动 / 修个 bug / 加个按钮 / 调样式 / 解释 / 跑个命令 / 端口冲突"等 → mode="dispatch"，并从下面成员里选 1-3 个最合适的 agentId 放进 targets，brief 写清楚要他们做什么。\n` +
      `- 不确定时倾向 dispatch（更轻、更快），除非明显是大项目。\n\n` +
      `可选成员（targets 只能从这些 id 选）：\n${catalog.text}\n\n` +
      `输出格式：{"mode":"plan"|"dispatch","targets":["<agentId>"],"brief":"<给执行者的一句话指令>"}`;

    const userMsg =
      (input.recentContext ? `最近对话（供判断上下文）：\n${input.recentContext}\n\n` : '') +
      `用户最新消息：\n${input.text}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    let raw = '';
    try {
      const req: ChatRequest = {
        taskId: 'triage-' + Date.now(),
        metadata: { purpose: 'triage', conversationId: input.conversationId },
        systemPrompt: sys,
        messages: [{ role: 'user', content: userMsg }],
        budget: { maxTokens: 400 },
      };
      for await (const ev of adapter.chat(req, ctrl.signal)) {
        if (ev.type === 'token') raw += ev.text;
        if (ev.type === 'error') return fallback;
      }
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }

    const parsed = extractJson(raw) as
      | { mode?: unknown; targets?: unknown; brief?: unknown }
      | null;
    if (!parsed) return fallback;
    const mode = parsed.mode === 'dispatch' ? 'dispatch' : 'plan';
    const targets = Array.isArray(parsed.targets)
      ? parsed.targets.filter((t): t is string => typeof t === 'string' && memberIds.includes(t))
      : [];
    const brief = typeof parsed.brief === 'string' && parsed.brief.trim() ? parsed.brief.trim() : input.text;
    // dispatch with no valid target is useless → fall back to planning.
    if (mode === 'dispatch' && targets.length === 0) return fallback;
    return { mode, targets, brief };
  }

  /**
   * One cheap, timeout-guarded summarization call used by context compaction.
   * Returns '' on any failure so the caller keeps the old summary (fail-open).
   */
  async summarizeForCompaction(input: string): Promise<string> {
    const adapter = this.pickAdapter();
    if (!adapter) return '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let raw = '';
    try {
      for await (const ev of adapter.chat(
        {
          taskId: 'compact-' + Date.now(),
          metadata: { purpose: 'compaction' },
          systemPrompt:
            '把下面的项目对话/进展压缩成一段中文摘要（≤ 200 字），只保留：当前目标、已确定的关键决策、已完成的部分、仍未解决的问题。' +
            '不要逐条复述，不要加客套，直接输出摘要正文。',
          messages: [{ role: 'user', content: input }],
          budget: { maxTokens: 320 },
        },
        ctrl.signal,
      )) {
        if (ev.type === 'token') raw += ev.text;
        if (ev.type === 'error') return '';
      }
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
    return raw.trim();
  }

  async getPlannerProfile(conversationId: string): Promise<PlannerAgentProfile | null> {
    const resolved = await this.resolvePlannerAgent(conversationId);
    if (!resolved) return null;
    return {
      agentId: resolved.agentId,
      adapterId: resolved.adapterId,
      name: resolved.name,
      systemPrompt: resolved.systemPrompt,
    };
  }

  private async resolvePlannerAgent(conversationId: string): Promise<ResolvedPlannerAgent | null> {
    const conv = await this.convs.getById(conversationId).catch(() => null);
    const members = conv?.members.filter((m) => m.agentId !== 'orchestrator' && m.agentId !== 'mock') ?? [];
    const selected =
      findMember(members, ['solution-architect']) ??
      members.find((m) => /架构|architect/i.test(`${m.name} ${m.systemPrompt ?? ''}`)) ??
      findMember(members, ['product-analyst']) ??
      members.find((m) => /规划|需求|产品|plan|product/i.test(`${m.name} ${m.systemPrompt ?? ''}`)) ??
      members[0];

    if (!selected) return null;
    const full = await this.agents.getByIdWithSecrets(selected.agentId);
    if (!full) return null;
    const adapter = this.adapterFactory.resolveForAgent({
      agentId: full.id,
      adapterId: full.adapterId,
      model: full.model,
      apiKey: full.apiKey,
      baseUrl: full.baseUrl,
    });
    return {
      agentId: full.id,
      adapterId: full.adapterId,
      name: full.name,
      systemPrompt: full.systemPrompt ?? '',
      adapter,
    };
  }

  private async agentCatalog(conversationId: string): Promise<{ text: string; ids: Set<string> }> {
    const conv = await this.convs.getById(conversationId).catch(() => null);
    const members = conv?.members.filter((m) => m.agentId !== 'orchestrator' && m.agentId !== 'mock') ?? [];
    if (members.length === 0) {
      return {
        ids: new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'codex']),
        text:
          `- deepseek-v4-flash：DeepSeek V4 Flash，通用对话 + 快速分析\n` +
          `- deepseek-v4-pro：DeepSeek V4 Pro，复杂推理 / 规划\n` +
          `- codex：代码实现 / 文件编辑 / 工具调用 / 终端验证`,
      };
    }

    return {
      ids: new Set(members.map((m) => m.agentId)),
      text: members
        .map((m) => {
          const role = m.systemPrompt?.trim()
            ? m.systemPrompt.trim().slice(0, 80)
            : `${m.name}，底层模型 ${m.adapterId}`;
          return `- ${m.agentId}：${role}`;
        })
        .join('\n'),
    };
  }

  private pickAdapter() {
    // The fast DeepSeek adapter follows JSON better than legacy reasoner-style outputs.
    const preference = ['deepseek-v4-flash', 'codex', 'doubao', 'mock'];
    for (const id of preference) if (this.registry.has(id)) return this.registry.get(id);
    return undefined;
  }

  private normalize(parsed: RawPlan, input: { conversationId: string; rootGoal: string }, availableIds = new Set<string>()): Plan {
    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const seenIds = new Set<string>();
    const tasks: PlanTask[] = [];

    for (let i = 0; i < rawTasks.length; i++) {
      const t = rawTasks[i] ?? {};
      const id = (t.id && !seenIds.has(t.id) ? t.id : `T${i + 1}`).slice(0, 32);
      seenIds.add(id);
      const goal = (t.goal ?? `子任务 ${i + 1}`).slice(0, 200);
      const details = typeof t.details === 'string' ? t.details.slice(0, 1200) : undefined;
      const deliverables = Array.isArray(t.deliverables)
        ? t.deliverables.filter((x): x is string => typeof x === 'string').slice(0, 8)
        : undefined;
      const checklist = Array.isArray(t.checklist)
        ? t.checklist.filter((x): x is string => typeof x === 'string').slice(0, 12)
        : undefined;
      const inputs = Array.isArray(t.inputs) ? t.inputs.filter((x): x is string => typeof x === 'string') : [];
      const acceptance: AcceptanceRule[] =
        Array.isArray(t.acceptance) && t.acceptance.length > 0
          ? t.acceptance
          : [{ kind: 'manual' }];
      const assignee = pickAssignee(t.candidateAgents, this.registry, goal, availableIds);
      tasks.push({
        id,
        goal,
        ...(details ? { details } : {}),
        ...(deliverables && deliverables.length > 0 ? { deliverables } : {}),
        ...(checklist && checklist.length > 0 ? { checklist } : {}),
        inputs,
        acceptance,
        status: inputs.length === 0 ? 'ready' : 'pending',
        retries: 0,
        ...(assignee ? { assigneeAgentId: assignee } : {}),
      });
    }

    // Drop edges referencing unknown tasks.
    const ids = new Set(tasks.map((t) => t.id));
    for (const t of tasks) t.inputs = t.inputs.filter((i) => ids.has(i));

    if (tasks.length === 0) return this.cannedPlan(input, availableIds);

    const now = new Date().toISOString();
    return {
      id: cryptoRandomId(),
      conversationId: input.conversationId,
      rootGoal: parsed.rootGoal ?? input.rootGoal,
      status: 'planning',
      tasks,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }

  private cannedPlan(input: { conversationId: string; rootGoal: string }, ids = new Set<string>()): Plan {
    const now = new Date().toISOString();
    const product = pickRole(ids, ['product-analyst', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3', 'deepseek-r1']) ?? pickDefault(this.registry);
    const architect = pickRole(ids, ['solution-architect', 'deepseek-v4-pro', 'deepseek-r1', 'deepseek-v4-flash', 'deepseek-v3']) ?? pickDefault(this.registry);
    const implementer = pickRole(ids, ['frontend-engineer', 'backend-engineer', 'codex', 'deepseek-v4-flash', 'deepseek-v3']) ?? pickCodingAgent(this.registry);
    const verifier = pickRole(ids, ['qa-tester', 'env-engineer', 'code-reviewer', 'codex']) ?? pickCodingAgent(this.registry);
    const critic = pickRole(ids, ['risk-critic', 'code-reviewer', 'senior-user', 'deepseek-v4-pro', 'deepseek-r1']) ?? pickDefault(this.registry);
    return {
      id: cryptoRandomId(),
      conversationId: input.conversationId,
      rootGoal: input.rootGoal,
      status: 'planning',
      tasks: [
        {
          id: 'T1',
          goal: '定义产品目标和验收标准',
          details: '把用户目标转成明确的范围、核心用户、非目标、成功标准和验收口径，避免后续实现靠猜。',
          deliverables: ['PROJECT.md 中的目标/范围/验收标准', '核心页面或功能清单'],
          checklist: ['目标明确', '非目标明确', '至少 5 条验收标准'],
          inputs: [],
          acceptance: [{ kind: 'manual' }],
          status: 'ready',
          retries: 0,
          assigneeAgentId: product,
        },
        {
          id: 'T2',
          goal: '设计文件结构和实现路线',
          details: '根据 T1 输出设计模块边界、文件结构、技术栈、数据流、交互流程和风险点，作为后续实现合同。',
          deliverables: ['TASKS.md 中的架构说明', '文件树和接口/状态设计'],
          checklist: ['文件结构可落地', '依赖关系清楚', '主要风险已列出'],
          inputs: ['T1'],
          acceptance: [{ kind: 'manual' }],
          status: 'pending',
          retries: 0,
          assigneeAgentId: architect,
        },
        {
          id: 'T3',
          goal: '实现可运行项目骨架和核心功能',
          details: '在 workspace 写入真实文件，完成入口、核心页面、交互状态和必要的本地数据逻辑，保证 Preview 能跑。',
          deliverables: ['可预览的前端入口文件', '核心组件/样式/脚本'],
          checklist: ['文件写入 workspace', '入口文件可识别', '无明显半截代码'],
          inputs: ['T2'],
          acceptance: [{ kind: 'compile' }],
          status: 'pending',
          retries: 0,
          assigneeAgentId: implementer,
        },
        {
          id: 'T4',
          goal: '运行验证并修复构建错误',
          details: '使用 workspace 里的命令或可用检查方式验证项目，修复 Preview/构建/运行错误，而不是只描述代码。',
          deliverables: ['验证命令和结果', '必要的修复补丁'],
          checklist: ['至少执行一次验证', '错误信息被处理', '最终状态可说明'],
          inputs: ['T3'],
          acceptance: [{ kind: 'compile' }],
          status: 'pending',
          retries: 0,
          assigneeAgentId: verifier,
        },
        {
          id: 'T5',
          goal: '审查体验、风险和交付缺口',
          details: '从真实用户、代码质量和边界风险角度检查产物，列出必须修的问题和可后续优化的问题。',
          deliverables: ['风险清单', '必须修复项', '后续优化建议'],
          checklist: ['指出阻断问题', '覆盖用户体验', '覆盖安全/边界风险'],
          inputs: ['T3'],
          acceptance: [{ kind: 'manual' }],
          status: 'pending',
          retries: 0,
          assigneeAgentId: critic,
        },
      ],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }
}

function extractJson(text: string): RawPlan | null {
  // Try fenced ```json block first, then the largest {...} substring.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as RawPlan;
  } catch {
    return null;
  }
}

/**
 * Resolve a task's assignee. Priority:
 *  1. An LLM-suggested candidate that is an actual conversation member.
 *  2. The conversation's role agent that best matches the goal (so the chat
 *     shows "前端工程师" doing it, not the raw "DeepSeek V4 Flash" model).
 *  3. Any conversation member.
 *  4. Only if there are NO members: a global registry model.
 */
function pickAssignee(
  candidates: string[] | undefined,
  registry: AdapterRegistry,
  goal: string,
  availableIds: Set<string>,
): string | undefined {
  const members = [...availableIds].filter((id) => id !== 'orchestrator' && id !== 'mock');

  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      if (typeof c === 'string' && members.includes(c)) return c;
    }
  }

  if (members.length > 0) {
    const role = inferRoleSuffix(goal);
    if (role) {
      const hit = members.find((id) => id.endsWith(role));
      if (hit) return hit;
    }
    // No clear role → coding goals go to an engineer member, else first member.
    if (isCodingGoal(goal)) {
      const eng = members.find((id) => /(frontend|backend)-engineer$/.test(id));
      if (eng) return eng;
    }
    return members[0];
  }

  // Fallback only when the conversation has no configured members at all.
  if (isCodingGoal(goal)) return pickCodingAgent(registry);
  return pickDefault(registry);
}

/** Map a task goal to a role-agent id suffix used by conv-agent ids. */
function inferRoleSuffix(goal: string): string | undefined {
  const g = goal.toLowerCase();
  if (/前端|界面|页面|组件|样式|ui|ux|preview|react|vue|css/.test(g)) return 'frontend-engineer';
  if (/后端|接口|api|数据库|服务端|server|backend|持久化|鉴权/.test(g)) return 'backend-engineer';
  if (/验证|测试|qa|编译|compile|build|运行错误|回归/.test(g)) return 'qa-tester';
  if (/审查|review|代码质量|risk|风险|安全|边界/.test(g)) return 'code-reviewer';
  if (/部署|环境|docker|脚本|依赖|ci|env/.test(g)) return 'env-engineer';
  if (/架构|设计|拆解|技术选型|模块|数据流|architecture/.test(g)) return 'solution-architect';
  if (/需求|目标|范围|验收|产品|prd|用户/.test(g)) return 'product-analyst';
  return undefined;
}

function pickRole(ids: Set<string>, preferred: string[]): string | undefined {
  for (const id of preferred) if (ids.has(id)) return id;
  return undefined;
}

function findMember<T extends { agentId: string }>(members: T[], preferred: string[]): T | undefined {
  for (const id of preferred) {
    const found = members.find((m) => m.agentId === id);
    if (found) return found;
  }
  return undefined;
}

function pickCodingAgent(registry: AdapterRegistry): string | undefined {
  for (const id of ['codex', 'deepseek-v4-flash', 'deepseek-v3', 'doubao', 'mock']) {
    if (registry.has(id)) return id;
  }
  return undefined;
}

function pickDefault(registry: AdapterRegistry): string | undefined {
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3', 'deepseek-r1', 'codex', 'doubao', 'mock']) {
    if (registry.has(id)) return id;
  }
  return undefined;
}

function isCodingGoal(goal: string): boolean {
  return /实现|前端|后端|联调|美化|页面|组件|API|接口|CRUD|部署|Docker|代码|修复|测试|compile|build|frontend|backend|deploy|style|ui/i.test(goal);
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
