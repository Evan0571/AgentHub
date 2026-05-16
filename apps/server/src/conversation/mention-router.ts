import { Inject, Injectable } from '@nestjs/common';
import type { AgentAdapter, AdapterRegistry, ChatRequest, ContentPart } from '@agenthub/adapter-core';
import { type ClientEvent, type MessageAttachment, type MessageContent, type ServerEvent, PROJECT_PLANNER_MENTION } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import type { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { AgentsRepo } from '../db/agents.repo.js';
import { ConversationsRepo } from '../db/conversations.repo.js';
import { TracingService } from '../observability/tracing.service.js';
import { AgentToolRunnerService } from '../workspace/agent-tool-runner.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';

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
    private readonly toolRunner: AgentToolRunnerService,
    private readonly workspace: WorkspaceService,
  ) {}

  async route(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    send: (e: ServerEvent) => void,
    orchestrator: OrchestratorService,
  ): Promise<void> {
    if (event.mentions.length === 0) return;

    // Project planning is an internal route. The visible planner speaker is
    // resolved by OrchestratorService from the conversation's architect member.
    if (event.mentions.includes(PROJECT_PLANNER_MENTION) || event.mentions.includes('orchestrator')) {
      // rootGoal must stay human-readable: it shows in the Plan panel and is
      // echoed back in chat. The verbose attachment block (hashes, full
      // workspace paths, text excerpts) is for the *executing* agents, not
      // the displayed goal — keep just the user's words + a short note.
      const goal = contentToPlannerGoal(event.content);
      await orchestrator.plan({ conversationId: event.conversationId, rootGoal: goal }, send);
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
    const userContent = await this.contentToAdapterContent(event.conversationId, event.content);

    await Promise.all(
      peers.map((self) =>
        this.invokeAgent({
          self,
          peers,
          groupRules,
          conversationId: event.conversationId,
          userContent,
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
    userContent: string | ContentPart[];
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

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}
