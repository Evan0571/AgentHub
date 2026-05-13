import { Inject, Injectable } from '@nestjs/common';
import type { AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { Plan, PlanTask, AcceptanceRule } from '@agenthub/shared-types';
import { planner as plannerPrompt } from '@agenthub/prompts';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';

interface RawTask {
  id?: string;
  goal?: string;
  inputs?: string[];
  acceptance?: AcceptanceRule[];
  candidateAgents?: string[];
}

interface RawPlan {
  rootGoal?: string;
  tasks?: RawTask[];
}

@Injectable()
export class PlannerService {
  constructor(@Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry) {}

  /**
   * Draft an initial DAG from a root goal using a Planner LLM.
   * Falls back to a canned 4-task plan when the LLM is unavailable or its
   * output cannot be parsed.
   */
  async draft(input: { conversationId: string; rootGoal: string }): Promise<Plan> {
    const adapter = this.pickAdapter();
    if (!adapter) return this.cannedPlan(input);

    const userMsg =
      `根目标：${input.rootGoal}\n\n` +
      `可用 Agent（id：能力）：\n` +
      `- deepseek-v3：通用对话 + 代码生成（快 / 便宜）\n` +
      `- deepseek-r1：复杂推理 / 算法 / 规划（带思考链）\n\n` +
      `请直接输出 Plan JSON，禁止额外文字。`;

    let raw = '';
    try {
      const req: ChatRequest = {
        taskId: 'planner-' + Date.now(),
        systemPrompt: plannerPrompt.systemPrompt,
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
      return this.cannedPlan(input);
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      console.warn('[planner] could not parse JSON; falling back. raw=', raw.slice(0, 200));
      return this.cannedPlan(input);
    }

    return this.normalize(parsed, input);
  }

  private pickAdapter() {
    // V3 follows JSON better than R1 (whose thinking mode adds noise).
    const preference = ['deepseek-v3', 'codex', 'doubao', 'mock'];
    for (const id of preference) if (this.registry.has(id)) return this.registry.get(id);
    return undefined;
  }

  private normalize(parsed: RawPlan, input: { conversationId: string; rootGoal: string }): Plan {
    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const seenIds = new Set<string>();
    const tasks: PlanTask[] = [];

    for (let i = 0; i < rawTasks.length; i++) {
      const t = rawTasks[i] ?? {};
      const id = (t.id && !seenIds.has(t.id) ? t.id : `T${i + 1}`).slice(0, 32);
      seenIds.add(id);
      const goal = (t.goal ?? `子任务 ${i + 1}`).slice(0, 200);
      const inputs = Array.isArray(t.inputs) ? t.inputs.filter((x): x is string => typeof x === 'string') : [];
      const acceptance: AcceptanceRule[] =
        Array.isArray(t.acceptance) && t.acceptance.length > 0
          ? t.acceptance
          : [{ kind: 'manual' }];
      const assignee = pickAssignee(t.candidateAgents, this.registry);
      tasks.push({
        id,
        goal,
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

    if (tasks.length === 0) return this.cannedPlan(input);

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

  private cannedPlan(input: { conversationId: string; rootGoal: string }): Plan {
    const now = new Date().toISOString();
    return {
      id: cryptoRandomId(),
      conversationId: input.conversationId,
      rootGoal: input.rootGoal,
      status: 'planning',
      tasks: [
        { id: 'T1', goal: '需求澄清与技术选型', inputs: [], acceptance: [{ kind: 'manual' }], status: 'ready', retries: 0, assigneeAgentId: 'deepseek-r1' },
        { id: 'T2', goal: '前端实现（React + Vite + Tailwind）', inputs: ['T1'], acceptance: [{ kind: 'compile' }], status: 'pending', retries: 0, assigneeAgentId: 'deepseek-v3' },
        { id: 'T3', goal: '后端实现（FastAPI + SQLite CRUD）', inputs: ['T1'], acceptance: [{ kind: 'compile' }], status: 'pending', retries: 0, assigneeAgentId: 'deepseek-v3' },
        { id: 'T4', goal: '联调 + Dockerfile + 一键部署说明', inputs: ['T2', 'T3'], acceptance: [{ kind: 'manual' }], status: 'pending', retries: 0, assigneeAgentId: 'deepseek-v3' },
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

function pickAssignee(candidates: string[] | undefined, registry: AdapterRegistry): string | undefined {
  if (Array.isArray(candidates)) {
    for (const c of candidates) if (typeof c === 'string' && registry.has(c)) return c;
  }
  // Default fallback in priority order.
  for (const id of ['deepseek-v3', 'deepseek-r1', 'codex', 'doubao', 'mock']) {
    if (registry.has(id)) return id;
  }
  return undefined;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
