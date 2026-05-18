import { Inject, Injectable } from '@nestjs/common';
import type { AgentAdapter, AdapterRegistry, ChatRequest, ContentPart } from '@agenthub/adapter-core';
import {
  type ClientEvent,
  type MessageAttachment,
  type MessageContent,
  type ServerEvent,
  type UserQuestion,
  type UserQuestionRequest,
  PROJECT_PLANNER_MENTION,
} from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import type { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { PlannerService } from '../orchestrator/planner.service.js';
import { PlanService } from '../orchestrator/plan.service.js';
import { TeamWakeService } from '../orchestrator/team-wake.service.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { AgentsRepo } from '../db/agents.repo.js';
import { ConversationsRepo } from '../db/conversations.repo.js';
import { TracingService } from '../observability/tracing.service.js';
import { AgentToolRunnerService } from '../workspace/agent-tool-runner.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { ProjectStateService } from '../workspace/project-state.service.js';

interface ResolvedAgent {
  agentId: string;          // the canonical agent id (UUID or built-in slug)
  adapterId: string;        // which adapter backs this agent
  name: string;             // display name shown in peer-aware prompt
  systemPrompt: string;     // custom role / system prompt on the agent itself
}

interface CoordinatorProgress {
  msgId: string;
  senderId: string;
  senderType: 'agent' | 'system';
}

/**
 * @ routing protocol (PRD §5.3):
 *   - user @AgentA          → invoke A directly
 *   - A's reply contains @B → invoke B with A's reply as user-role context
 *   - @all                  → broadcast to every member
 *   - no @                  → message logged, no agent triggered
 * Hop counter prevents Agent-to-Agent infinite loops (default cap = 6).
 */
const HOP_LIMIT = 6;

const DEFAULT_SYSTEM_PROMPT = `你是 AgentHub 群聊中的助手。请遵守如下输出规范：

1. **代码块必须带文件路径**。在 fenced code block 的语言标签后写 \`path=相对路径\`，例如：
   \`\`\`tsx path=src/components/Counter.tsx
   ...代码...
   \`\`\`
   如果是脚本 / 临时片段，可以不带 path，但仍要写语言。

2. **修改既有文件优先输出 unified diff**（语言标记为 \`diff\`），不要重发整文件：
   \`\`\`diff path=src/Foo.ts
   @@ ... @@
   - old
   + new
   \`\`\`

3. 使用 Markdown：列表用 \`-\`，强调用 \`**bold**\`，命令用行内 \`code\`。
4. 中文回复（除非用户用英文提问）。简洁、有结论先行。
5. 多文件 React 项目：**入口文件优先命名为 \`App.tsx\` 或 \`main.tsx\`**；子组件用 PascalCase basename（如 \`TodoItem.tsx\`），路径用 \`src/components/\` 前缀；ESM \`import\` 语法允许，第三方库默认走 esm.sh（react / react-dom / lucide-react / clsx / zustand）。

## 输出风格
- 不要使用 emoji，不要写 AI 助手式客套话。
- 不要用"我将/首先/接下来/总结/如需请告知"作为段落模板。
- 已经通过工具完成的事只报告结果和关键文件；不要把每一步工具调用复述进最终正文。
- 遇到信息不足但不影响方向时，基于项目名称、附件、工作区文件做合理假设并推进。
- 如果缺失信息会改变产品形态、数据/合规边界、部署成本、外部凭据或用户预期粒度，必须先问用户 2-4 个具体问题或给出选项，不要硬猜。

## 团队协作准则（所有角色都要遵守）
- **不要急，允许多轮迭代**：完整项目不可能一次做完。先打通最小闭环，再分轮迭代增强；可以做"预处理/打地基"的过渡产出，不要假装一步到位。
- **互相沟通**：你的改动如果会影响别人的产物（改了接口契约、文件结构、数据模型、共享类型等），必须在回复里 @ 受影响的角色，让他们对齐，并简述改了什么、为什么。
- **遇到不确定先推进**：需求模糊但不阻断时，写下合理假设并继续推进；只有代价大且无法判断时才 @ 用户确认。
- **共享记忆**：PROJECT.md 是项目锚点，TEAM_MEMORY.md 是团队共享记忆。改了环境变量、Docker、接口、数据模型、验收标准或跨角色交接时，把简短结论写入 TEAM_MEMORY.md。
- **禁止空壳交付**：前端不能只有占位卡片/假图表/假 KPI；后端不能只有假接口；需要用户配置的 key/token/URL 要写入 .env.example 并说明用途。
- **禁止占用 3000 / 4000 端口**（用户本机的开发服务正在用）。需要本地起服务一律换 5173 / 8080 等其它端口；优先用 \`npm run build\` / \`tsc\` 这类会退出的命令验证，不要长跑 dev server（\`npm run start\` / \`vite\` 常驻进程）。`;

@Injectable()
export class MentionRouter {
  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly messages: MessagesRepo,
    private readonly tracing: TracingService,
    private readonly agentsRepo: AgentsRepo,
    private readonly convsRepo: ConversationsRepo,
    private readonly adapterFactory: AdapterFactoryService,
    private readonly toolRunner: AgentToolRunnerService,
    private readonly workspace: WorkspaceService,
    private readonly planner: PlannerService,
    private readonly projectState: ProjectStateService,
    private readonly plans: PlanService,
    private readonly teamWake: TeamWakeService,
  ) {}

  async route(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    send: (e: ServerEvent) => void,
    orchestrator: OrchestratorService,
  ): Promise<void> {
    if (event.mentions.length === 0) return;

    // The 组长 path: no explicit @ (PROJECT_PLANNER_MENTION), legacy
    // 'orchestrator', OR the user explicitly @-ed the team-lead. In all three
    // cases run triage (dispatch vs real Plan) — NOT plain chat, otherwise
    // the 组长 just writes prose about who-does-what and nobody is actually
    // assigned, which is exactly the bug the user hit.
    const mentionsLead = event.mentions.some(
      (m) => m === 'team-lead' || m.endsWith('-team-lead'),
    );
    if (
      event.mentions.includes(PROJECT_PLANNER_MENTION) ||
      event.mentions.includes('orchestrator') ||
      mentionsLead
    ) {
      const goal = contentToPlannerGoal(event.content);
      const rawText = event.content.kind === 'text' ? event.content.text : goal;
      const recentContext = await this.buildRecentContext(event.conversationId, 10);

      if (isProjectStatusQuery(rawText)) {
        await this.emitPlanStatus(event.conversationId, send);
        return;
      }

      // Once per project turn, fold older transcript into the rolling summary
      // (Cursor/Codex-style compaction). Fire-and-forget + fail-open so it
      // never adds latency or blocks the response.
      void this.buildRecentContext(event.conversationId, 40)
        .then((transcript) =>
          this.projectState.compact(event.conversationId, transcript, (input) =>
            this.planner.summarizeForCompaction(input),
          ),
        )
        .catch(() => undefined);

      // The whole 组长 path is guarded: triage / plan can throw or time out,
      // but a group message must NEVER get a silent non-reply — always leave
      // at least one visible 组长 message in the chat.
      const routing = await this.startCoordinatorProgress(event.conversationId, send);
      try {
        const triage = await this.planner.triage({
          conversationId: event.conversationId,
          text: rawText,
          recentContext,
        });

        if (triage.mode === 'clarify') {
          await this.finishCoordinatorProgress(
            event.conversationId,
            routing,
            '需要你先确认几个关键选择；下面的问题会直接决定任务拆分和交付标准。',
            send,
          );
          const questionRequest = buildQuestionRequest({
            conversationId: event.conversationId,
            sourceAgentId: routing.senderType === 'agent' ? routing.senderId : undefined,
            sourceAgentName: '项目组长',
            reason: triage.brief,
            questions: triage.questions,
            originalGoal: goal,
          });
          send({
            op: 'agent_state',
            conversationId: event.conversationId,
            agentId: questionRequest.sourceAgentId,
            agentName: questionRequest.sourceAgentName,
            msgId: routing.msgId,
            state: 'waiting_user',
            reason: '等待你回答澄清问题后继续规划',
            updatedAt: new Date().toISOString(),
          });
          send({ op: 'ask_user_question', request: questionRequest });
          return;
        }

        if (triage.mode === 'dispatch' && triage.targets.length > 0) {
          await this.tracing.runWithTrace(
            {
              name: 'lead_dispatch',
              sessionId: event.conversationId,
              metadata: { conversationId: event.conversationId, targets: triage.targets },
            },
            () => this.dispatchDirectly(event, triage.targets, triage.brief, send, routing),
          );
          return;
        }

        // plan mode: 组长 narrates the hand-off, then the architect produces a
        // real Plan DAG (orchestrator.plan resolves the architect as planner).
        await this.finishCoordinatorProgress(
          event.conversationId,
          routing,
          `进入项目执行规划：先生成任务 DAG，再按角色推进。`,
          send,
        );
        await orchestrator.plan({ conversationId: event.conversationId, rootGoal: goal }, send);
      } catch (e) {
        console.error('[mention-router] 组长 path failed:', e);
        await this.finishCoordinatorProgress(
          event.conversationId,
          routing,
          `组长处理失败：${(e as Error).message || '未知错误'}。\n可以重发，或查看 server 控制台日志。`,
          send,
        ).catch(() => undefined);
      }
      return;
    }

    // Wrap the whole multi-@ fan-out in one Langfuse trace so all parallel
    // agent generations show up grouped under "user_msg".
    return this.tracing.runWithTrace(
      {
        name: 'user_msg',
        sessionId: event.conversationId,
        metadata: {
          conversationId: event.conversationId,
          mentions: event.mentions,
        },
      },
      () => this.routeImpl(event, send),
    );
  }

  private async routeImpl(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    // Resolve every mention into a real agent (with its system prompt + which
    // adapter to call). Agents are now first-class DB rows — built-ins seeded
    // with empty system prompt, custom ones have user-defined roles.
    const resolved = await Promise.all(event.mentions.map((m) => this.resolveAgent(m)));
    const peers = resolved.filter((r): r is ResolvedAgent => r !== null);

    // Conversation-level system prompt ("group rules"), if any.
    const realConvId = this.messages.resolveConversationUuid(event.conversationId);
    const conv = realConvId ? await this.convsRepo.getById(realConvId) : null;
    const groupRules = conv?.groupSystemPrompt ?? null;
    const teamRoster = renderTeamRoster(conv?.members ?? []);
    const userContent = await this.contentToAdapterContent(event.conversationId, event.content);
    const recentContext = await this.buildRecentContext(event.conversationId, 10);

    await Promise.all(
      peers.map((self) =>
        this.invokeAgent({
          self,
          peers,
          groupRules,
          teamRoster,
          conversationId: event.conversationId,
          userContent,
          recentContext,
          hop: 0,
          send,
        }),
      ),
    );
  }

  /**
   * Small-change path: the architect hands the message straight to specific
   * engineers instead of building a Plan DAG. Posts a short "我交给 X" note
   * (as the architect) then invokes the chosen members directly.
   */
  private async dispatchDirectly(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    targetIds: string[],
    brief: string,
    send: (e: ServerEvent) => void,
    handoff?: CoordinatorProgress,
  ): Promise<void> {
    const resolved = (
      await Promise.all(targetIds.map((id) => this.resolveAgent(id)))
    ).filter((r): r is ResolvedAgent => r !== null);
    if (resolved.length === 0) {
      if (handoff) {
        await this.finishCoordinatorProgress(event.conversationId, handoff, '没有解析到可用成员，派单停止。', send);
      }
      return;
    }

    const realConvId = this.messages.resolveConversationUuid(event.conversationId);
    const conv = realConvId ? await this.convsRepo.getById(realConvId) : null;
    const groupRules = conv?.groupSystemPrompt ?? null;
    const teamRoster = renderTeamRoster(conv?.members ?? []);

    // 组长 hand-off note (so the chat shows the routing decision).
    const leadId = (await this.resolveCoordinatorSpeaker(event.conversationId)) ?? 'system';
    const noteId = handoff?.msgId ?? cryptoRandomId();
    const names = resolved.map((r) => r.name).join('、');
    if (!handoff) {
      send({
        op: 'msg_started',
        message: {
          id: noteId,
          conversationId: event.conversationId,
          senderType: leadId === 'system' ? 'system' : 'agent',
          senderId: leadId,
          createdAt: new Date().toISOString(),
        },
      });
    }
    const note = `派单给 **${names}**：\n\n> ${brief}`;
    send({ op: 'msg_token', msgId: noteId, delta: note });
    send({ op: 'msg_done', msgId: noteId });
    void this.messages
      .insert({
        conversationSlug: event.conversationId,
        senderType: handoff?.senderType ?? (leadId === 'system' ? 'system' : 'agent'),
        senderId: handoff?.senderId ?? leadId,
        text: note,
      })
      .catch(() => undefined);

    // Build user content from the original message (keeps attachments/images)
    // but prepend the 组长's brief so the engineer has a clear directive.
    const baseContent = await this.contentToAdapterContent(event.conversationId, event.content);
    const userContent =
      typeof baseContent === 'string'
        ? `组长派单：${brief}\n\n用户原话：${baseContent}`
        : [{ type: 'text' as const, text: `组长派单：${brief}` }, ...baseContent];
    const recentContext = await this.buildRecentContext(event.conversationId, 10);

    await Promise.all(
      resolved.map((self) =>
        this.invokeAgent({
          self,
          peers: resolved,
          groupRules,
          teamRoster,
          conversationId: event.conversationId,
          userContent,
          recentContext,
          hop: 0,
          send,
        }),
      ),
    );
  }

  private async startCoordinatorProgress(
    conversationId: string,
    send: (e: ServerEvent) => void,
  ): Promise<CoordinatorProgress> {
    const leadId = (await this.resolveCoordinatorSpeaker(conversationId)) ?? 'system';
    const progress: CoordinatorProgress = {
      msgId: cryptoRandomId(),
      senderId: leadId,
      senderType: leadId === 'system' ? 'system' : 'agent',
    };
    send({
      op: 'msg_started',
      message: {
        id: progress.msgId,
        conversationId,
        senderType: progress.senderType,
        senderId: progress.senderId,
        createdAt: new Date().toISOString(),
      },
    });
    send({
      op: 'msg_thinking',
      msgId: progress.msgId,
      delta: '接收用户消息，正在判断是直接派单、生成 Plan，还是先向用户澄清关键选择。\n',
    });
    return progress;
  }

  private async finishCoordinatorProgress(
    conversationId: string,
    progress: CoordinatorProgress,
    text: string,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    send({ op: 'msg_token', msgId: progress.msgId, delta: text });
    send({ op: 'msg_done', msgId: progress.msgId });
    void this.messages
      .insert({
        conversationSlug: conversationId,
        senderType: progress.senderType,
        senderId: progress.senderId,
        text,
      })
      .catch(() => undefined);
  }

  /** Resolve the conversation's architect agentId for the hand-off speaker. */
  /** Post a short message spoken by the 组长 (or system fallback). */
  private async emitCoordinatorNote(
    conversationId: string,
    text: string,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    const leadId = (await this.resolveCoordinatorSpeaker(conversationId)) ?? 'system';
    const id = cryptoRandomId();
    send({
      op: 'msg_started',
      message: {
        id,
        conversationId,
        senderType: leadId === 'system' ? 'system' : 'agent',
        senderId: leadId,
        createdAt: new Date().toISOString(),
      },
    });
    send({ op: 'msg_token', msgId: id, delta: text });
    send({ op: 'msg_done', msgId: id });
    void this.messages
      .insert({
        conversationSlug: conversationId,
        senderType: leadId === 'system' ? 'system' : 'agent',
        senderId: leadId,
        text,
      })
      .catch(() => undefined);
  }

  private async emitPlanStatus(
    conversationId: string,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    const plan = await this.plans.latestForConversation(conversationId);
    if (!plan) {
      await this.emitCoordinatorNote(
        conversationId,
        '当前没有正在跟踪的 Plan。可以直接描述下一步要做的产物，我会按角色派单。',
        send,
      );
      return;
    }

    const counts = new Map<string, number>();
    for (const task of plan.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    const unfinished = plan.tasks.filter((t) =>
      !['succeeded', 'cancelled'].includes(t.status),
    );
    const lines = [
      `当前 Plan：${plan.rootGoal}`,
      `状态：${plan.status}`,
      `进度：${counts.get('succeeded') ?? 0}/${plan.tasks.length} 个任务完成`,
    ];
    if (unfinished.length > 0) {
      lines.push('', '未完成任务：');
      for (const task of unfinished.slice(0, 8)) {
        lines.push(`- ${task.id} [${task.status}] ${task.goal}`);
      }
      if (unfinished.length > 8) lines.push(`- 还有 ${unfinished.length - 8} 个任务未列出`);
    } else {
      lines.push('', 'Plan 内任务已经全部完成。下一步应做集成验收和真实运行检查。');
    }
    await this.emitCoordinatorNote(conversationId, lines.join('\n'), send);
  }

  /** The 组长 (coordinator) is the visible speaker for triage/dispatch. */
  private async resolveCoordinatorSpeaker(conversationId: string): Promise<string | null> {
    const realId = this.messages.resolveConversationUuid(conversationId);
    const conv = realId ? await this.convsRepo.getById(realId) : null;
    const members = conv?.members.filter((m) => m.agentId !== 'orchestrator' && m.agentId !== 'mock') ?? [];
    const lead =
      members.find((m) => m.agentId.endsWith('team-lead')) ??
      members.find((m) => /组长|lead|协调|调度/i.test(`${m.name} ${m.systemPrompt ?? ''}`)) ??
      members.find((m) => m.agentId.endsWith('solution-architect')) ??
      members.find((m) => /架构|architect/i.test(`${m.name} ${m.systemPrompt ?? ''}`));
    return lead?.agentId ?? null;
  }

  /** Compact transcript of the last `limit` messages — working memory (#3a). */
  async buildRecentContext(conversationId: string, limit: number): Promise<string> {
    const all = await this.messages.list(conversationId).catch(() => []);
    if (all.length === 0) return '';
    const recent = all.slice(-limit);
    const lines = recent.map((m) => {
      const who =
        m.senderType === 'user' ? '用户' : m.senderType === 'system' ? '系统' : m.senderId;
      const text = m.text.replace(/```[\s\S]*?```/g, ' [代码块] ').replace(/\s+/g, ' ').trim();
      return `[${who}] ${text.length > 240 ? text.slice(0, 240) + '…' : text}`;
    });
    return lines.join('\n');
  }

  /** Look up an agent row → fall back to adapter-id-as-agent for legacy callers. */
  private async resolveAgent(mention: string): Promise<ResolvedAgent | null> {
    const a = await this.agentsRepo.getById(mention);
    if (a) {
      const adapterId =
        this.registry.has(a.adapterId) ? a.adapterId : this.fallbackAdapter();
      return {
        agentId: a.id,
        adapterId,
        name: a.name,
        systemPrompt: a.systemPrompt ?? '',
      };
    }
    // Legacy: caller passed an adapter id directly (e.g. 'deepseek-v4-flash') and
    // somehow it isn't in the DB. Use a synthesized profile.
    const adapterId = this.registry.has(mention) ? mention : this.fallbackAdapter();
    return {
      agentId: mention,
      adapterId,
      name: mention,
      systemPrompt: '',
    };
  }

  private fallbackAdapter(): string {
    const preference = ['deepseek-v4-flash', 'claude-code', 'codex', 'doubao', 'mock'];
    for (const id of preference) if (this.registry.has(id)) return id;
    return 'mock';
  }

  /**
   * Build a per-invocation system prompt. When the user @-mentioned multiple
   * agents in this turn, append a section telling each agent who its peers
   * are and that it should only produce ITS share — not try to cover all
   * styles itself.
   */
  /**
   * Compose the final system prompt for one agent's invocation:
   *   1. DEFAULT (output conventions)
   *   2. Conversation-level "group rules" (if set)
   *   3. The agent's own role / system prompt
   *   4. Peer-awareness block ("you are X, peers are Y; only do your share")
   */
  private buildSystemPrompt(
    self: ResolvedAgent,
    peers: ResolvedAgent[],
    groupRules: string | null,
    teamRoster?: string,
    recentContext?: string,
  ): string {
    const blocks: string[] = [DEFAULT_SYSTEM_PROMPT];
    if (groupRules && groupRules.trim()) {
      blocks.push(`## 群规则\n\n${groupRules.trim()}`);
    }
    if (teamRoster && teamRoster.trim()) {
      blocks.push(`## 团队名册与交接规则\n\n${teamRoster.trim()}`);
    }
    if (self.systemPrompt && self.systemPrompt.trim()) {
      blocks.push(`## 你的角色：${self.name}\n\n${self.systemPrompt.trim()}`);
    }
    if (recentContext && recentContext.trim()) {
      blocks.push(
        `## 最近对话（工作记忆，越靠下越新）\n\n${recentContext.trim()}\n\n` +
          `用户可能在过程中补充或修改了要求 —— 以上面最新的为准，不要"失忆"。`,
      );
    }
    const others = peers.filter((p) => p.agentId !== self.agentId);
    if (others.length > 0) {
      const peerNames = others.map((p) => p.name).join('、');
      blocks.push(
        `## 多 Agent 协作上下文\n\n` +
          `**用户的同一条消息也同时发给了**：${peerNames}。\n` +
          `**你的身份**：${self.name}。\n\n` +
          `重要约束：\n` +
          `- 你只产出**你自己的那一份**回复，不要替别人写，不要列出他们的版本，不要做横向对比。\n` +
          `- 用户说"各写一个 X / 各自实现 / 各用自己风格"时，你**只写一个 X**（属于你的那个）。不要列"风格 1 / 风格 2"。\n` +
          `- 用户说"对比 / diff" 时，你只发表你的看法，让别的 Agent 自己说他们的。\n` +
          `- 即使其他 Agent 还没回复，也不要替他们设想或代笔。`,
      );
    }
    return blocks.join('\n\n');
  }

  private async invokeAgent(args: {
    self: ResolvedAgent;
    peers: ResolvedAgent[];
    groupRules: string | null;
    teamRoster?: string;
    conversationId: string;
    userContent: string | ContentPart[];
    recentContext?: string;
    hop: number;
    send: (e: ServerEvent) => void;
  }): Promise<void> {
    if (args.hop >= HOP_LIMIT) {
      args.send({
        op: 'error',
        code: 'HOP_LIMIT_EXCEEDED',
        message: 'Agent-to-Agent mention chain exceeded hop limit',
        retryable: false,
      });
      return;
    }

    // Resolve via factory so BYOK / per-agent model / custom baseUrl all
    // funnel through one place. Reads the (decrypted) agent secrets only
    // here — they never leave the server.
    const full = await this.agentsRepo.getByIdWithSecrets(args.self.agentId);
    const adapter: AgentAdapter = this.adapterFactory.resolveForAgent({
      agentId: args.self.agentId,
      adapterId: args.self.adapterId,
      model: full?.model ?? null,
      apiKey: full?.apiKey ?? null,
      baseUrl: full?.baseUrl ?? null,
    });
    const msgId = cryptoRandomId();
    const req: ChatRequest = {
      taskId: msgId,
      systemPrompt: this.buildSystemPrompt(
        args.self,
        args.peers,
        args.groupRules,
        args.teamRoster,
        args.recentContext,
      ),
      messages: [{ role: 'user', content: args.userContent }],
      workspace: {
        id: args.conversationId,
        snapshotId: 'head',
      },
      metadata: {
        purpose: 'chat',
        agentId: args.self.agentId,
        adapterId: args.self.adapterId,
        agentName: args.self.name,
      },
    };

    args.send({
      op: 'msg_started',
      message: {
        id: msgId,
        conversationId: args.conversationId,
        senderType: 'agent',
        // We send the canonical agent id; the client maps it to display profile.
        senderId: args.self.agentId,
        createdAt: new Date().toISOString(),
      },
    });

    const run = await this.toolRunner.run({
      adapter,
      request: req,
      conversationId: args.conversationId,
      msgId,
      send: args.send,
    });
    const assembled = run.output;

    if (assembled.trim()) {
      void this.messages
        .insert({
          conversationSlug: args.conversationId,
          senderType: 'agent',
          senderId: args.self.agentId,
          text: assembled,
        })
        .catch((e) => console.warn('[mention-router] persist agent msg failed', e));
    }

    await this.teamWake.processPending(args.conversationId, args.send, {
      reason: `directed handoff after ${args.self.name}`,
    });
  }

  private async contentToAdapterContent(conversationId: string, content: MessageContent): Promise<string | ContentPart[]> {
    if (content.kind !== 'text') return '';
    const attachments = content.attachments ?? [];
    if (attachments.length === 0) return content.text;

    const text = await this.contentToPromptText(conversationId, content);
    const parts: ContentPart[] = [{ type: 'text', text }];

    for (const attachment of attachments) {
      if (attachment.kind !== 'image') continue;
      try {
        const file = await this.workspace.readBinaryFile(conversationId, {
          path: attachment.path,
          maxBytes: 5 * 1024 * 1024,
        });
        parts.push({
          type: 'image',
          mimeType: attachment.mimeType,
          base64: file.buffer.toString('base64'),
        });
      } catch {
        // Keep the text reference; don't fail the whole chat if a thumbnail is too large/missing.
      }
    }

    return parts.length > 1 ? parts : text;
  }

  private async contentToPromptText(conversationId: string, content: MessageContent): Promise<string> {
    if (content.kind !== 'text') return '';
    const attachments = content.attachments ?? [];
    if (attachments.length === 0) return content.text;

    const blocks = [content.text.trim() || '(用户只上传了附件，没有输入文字)'];
    blocks.push(
      [
        '',
        '## 用户上传的附件',
        ...attachments.map(
          (file, index) =>
            `${index + 1}. ${file.name} (${file.kind}, ${file.mimeType || 'unknown'}, ${formatBytes(file.size)}) - workspace path: ${file.path}`,
        ),
      ].join('\n'),
    );

    const excerpts = await this.readTextAttachmentExcerpts(conversationId, attachments);
    if (excerpts.length > 0) {
      blocks.push(['## 附件文本摘录', ...excerpts].join('\n\n'));
    }

    return blocks.join('\n\n');
  }

  private async readTextAttachmentExcerpts(conversationId: string, attachments: MessageAttachment[]): Promise<string[]> {
    const excerpts: string[] = [];
    for (const file of attachments) {
      if (file.kind !== 'text') continue;
      try {
        const read = await this.workspace.readFile(conversationId, {
          path: file.path,
          maxBytes: 16_000,
        });
        excerpts.push(`### ${file.name}\n\`\`\`\n${read.content}${read.truncated ? '\n...[truncated]' : ''}\n\`\`\``);
      } catch {
        excerpts.push(`### ${file.name}\n无法读取文本内容，请使用 workspace_read 读取 ${file.path}`);
      }
    }
    return excerpts;
  }
}

function buildQuestionRequest(input: {
  conversationId: string;
  sourceAgentId?: string;
  sourceAgentName: string;
  reason: string;
  questions?: UserQuestion[];
  originalGoal: string;
}): UserQuestionRequest {
  const questions =
    input.questions && input.questions.length > 0
      ? input.questions
      : [
          {
            id: 'scope',
            header: '粒度',
            question: '这次先按什么交付粒度推进？',
            options: [
              {
                id: 'mvp',
                label: '本地 MVP',
                description: '先打通真实可运行的最小闭环，后续再增强。',
                recommended: true,
              },
              {
                id: 'full',
                label: '完整骨架',
                description: '一次性搭出更完整的功能骨架，但验证范围会更大。',
              },
              {
                id: 'design',
                label: '先定方案',
                description: '先沉淀产品/架构方案，再进入实现。',
              },
            ],
          },
        ];
  return {
    id: cryptoRandomId(),
    conversationId: input.conversationId,
    sourceAgentId: input.sourceAgentId,
    sourceAgentName: input.sourceAgentName,
    title: '需要确认关键选择',
    reason: input.reason,
    questions,
    resumePrompt: `原始目标：\n${input.originalGoal}`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Clean, human-readable goal for the Plan panel + chat echo. Attachments are
 * summarized in one short line (count only) — the executing agents still get
 * the full path/excerpt context via `contentToAdapterContent`.
 */
function contentToPlannerGoal(content: MessageContent): string {
  if (content.kind !== 'text') return '';
  const text = content.text.trim();
  const n = content.attachments?.length ?? 0;
  if (n === 0) return text || '(空目标)';
  const note = `（含 ${n} 个上传附件，已存入工作区 attachments/ 目录）`;
  return text ? `${text}\n${note}` : `用户上传了 ${n} 个附件，请据此推进。${note}`;
}

function isProjectStatusQuery(text: string): boolean {
  return /还有.*任务|任务.*没做完|进度|现在.*状态|做到哪|剩.*什么|完成.*了吗|下一步.*什么/.test(text);
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
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
    '协作规则：把共享接口、文件结构、验证命令、环境变量、Docker 服务和阻塞物写清楚；持久结论写入 TEAM_MEMORY.md；如果改动会影响别人，点名相关角色并给出交接说明；不要替其他成员产出正文。',
  ].join('\n');
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
