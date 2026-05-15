import { Inject, Injectable } from '@nestjs/common';
import type { AgentAdapter, AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import type { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { AgentsRepo } from '../db/agents.repo.js';
import { ConversationsRepo } from '../db/conversations.repo.js';
import { TracingService } from '../observability/tracing.service.js';

interface ResolvedAgent {
  agentId: string;          // the canonical agent id (UUID or built-in slug)
  adapterId: string;        // which adapter backs this agent
  name: string;             // display name shown in peer-aware prompt
  systemPrompt: string;     // custom role / system prompt on the agent itself
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
5. 多文件 React 项目：**入口文件优先命名为 \`App.tsx\` 或 \`main.tsx\`**；子组件用 PascalCase basename（如 \`TodoItem.tsx\`），路径用 \`src/components/\` 前缀；ESM \`import\` 语法允许，第三方库默认走 esm.sh（react / react-dom / lucide-react / clsx / zustand）。`;

@Injectable()
export class MentionRouter {
  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly messages: MessagesRepo,
    private readonly tracing: TracingService,
    private readonly agentsRepo: AgentsRepo,
    private readonly convsRepo: ConversationsRepo,
    private readonly adapterFactory: AdapterFactoryService,
  ) {}

  async route(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    send: (e: ServerEvent) => void,
    orchestrator: OrchestratorService,
  ): Promise<void> {
    if (event.mentions.length === 0) return;

    // If user explicitly invokes Orchestrator (mention "@orchestrator"),
    // delegate the goal to it instead of a single agent. Orchestrator opens
    // its own trace internally.
    if (event.mentions.includes('orchestrator')) {
      const text = event.content.kind === 'text' ? event.content.text : '';
      await orchestrator.plan({ conversationId: event.conversationId, rootGoal: text }, send);
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

    await Promise.all(
      peers.map((self) =>
        this.invokeAgent({
          self,
          peers,
          groupRules,
          conversationId: event.conversationId,
          userText: event.content.kind === 'text' ? event.content.text : '',
          hop: 0,
          send,
        }),
      ),
    );
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
    // Legacy: caller passed an adapter id directly (e.g. 'deepseek-v3') and
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
    const preference = ['deepseek-v3', 'claude-code', 'codex', 'doubao', 'mock'];
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
  private buildSystemPrompt(self: ResolvedAgent, peers: ResolvedAgent[], groupRules: string | null): string {
    const blocks: string[] = [DEFAULT_SYSTEM_PROMPT];
    if (groupRules && groupRules.trim()) {
      blocks.push(`## 群规则\n\n${groupRules.trim()}`);
    }
    if (self.systemPrompt && self.systemPrompt.trim()) {
      blocks.push(`## 你的角色：${self.name}\n\n${self.systemPrompt.trim()}`);
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
    conversationId: string;
    userText: string;
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
      systemPrompt: this.buildSystemPrompt(args.self, args.peers, args.groupRules),
      messages: [{ role: 'user', content: args.userText }],
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

    let assembled = '';
    for await (const ev of adapter.chat(req)) {
      switch (ev.type) {
        case 'token':
          assembled += ev.text;
          args.send({ op: 'msg_token', msgId, delta: ev.text });
          break;
        case 'thinking':
          args.send({ op: 'msg_thinking', msgId, delta: ev.text });
          break;
        case 'file_patch':
          args.send({
            op: 'patch',
            msgId,
            snapshotId: cryptoRandomId(),
            files: [
              {
                path: ev.path,
                status: 'modified',
                additions: 0,
                deletions: 0,
                hunks: [{ id: cryptoRandomId(), header: ev.path }],
              },
            ],
          });
          break;
        case 'done':
          args.send({ op: 'msg_done', msgId, usage: ev.usage });
          break;
        case 'error':
          args.send({ op: 'msg_error', msgId, error: ev.error });
          break;
      }
    }

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
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
