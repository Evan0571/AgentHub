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
      `可用 Agent（id：能力）：\n` +
      catalog.text +
      `\n\n` +
      `请直接输出 Plan JSON，禁止额外文字。`;

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
        budget: { maxTokens: 800 },
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
      const assignee = pickAssignee(t.candidateAgents, this.registry, goal);
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

function pickAssignee(candidates: string[] | undefined, registry: AdapterRegistry, goal: string): string | undefined {
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() && c !== 'orchestrator') return c;
    }
  }
  if (isCodingGoal(goal)) return pickCodingAgent(registry);
  // Default fallback in priority order.
  return pickDefault(registry);
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
