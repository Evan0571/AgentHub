import { Inject, Injectable } from '@nestjs/common';
import type { AgentAdapter, AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import type { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { TracingService } from '../observability/tracing.service.js';

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

    // Resolve every mention to its concrete adapter id so each agent knows
    // *who else* the user is asking in parallel. Without this, agents
    // receive the same prompt independently and each tries to cover all
    // requested styles (e.g. "@A @B 各写一个 X" → A writes both styles, B
    // also writes both styles).
    const peerAdapterIds = event.mentions.map((m) => this.resolveAdapter(m));
    await Promise.all(
      peerAdapterIds.map((adapterId) =>
        this.invokeAgent({
          adapterId,
          peerAdapterIds,
          conversationId: event.conversationId,
          userText: event.content.kind === 'text' ? event.content.text : '',
          hop: 0,
          send,
        }),
      ),
    );
  }

  /**
   * Build a per-invocation system prompt. When the user @-mentioned multiple
   * agents in this turn, append a section telling each agent who its peers
   * are and that it should only produce ITS share — not try to cover all
   * styles itself.
   */
  private buildSystemPrompt(selfId: string, peerAdapterIds: string[]): string {
    const peers = peerAdapterIds.filter((id) => id !== selfId);
    if (peers.length === 0) return DEFAULT_SYSTEM_PROMPT;

    const nameOf = (id: string) => (this.registry.has(id) ? this.registry.get(id).displayName : id);
    const selfName = nameOf(selfId);
    const peerNames = peers.map(nameOf).join('、');

    return (
      DEFAULT_SYSTEM_PROMPT +
      `\n\n## 多 Agent 协作上下文\n\n` +
      `**用户的同一条消息也同时发给了**：${peerNames}。\n` +
      `**你的身份**：${selfName}。\n\n` +
      `重要约束：\n` +
      `- 你只产出**你自己的那一份**回复，不要替别人写，不要列出他们的版本，不要做横向对比。\n` +
      `- 用户说"各写一个 X / 各自实现 / 各用自己风格"时，你**只写一个 X**（属于你的那个）。不要列"风格 1 / 风格 2"。\n` +
      `- 用户说"对比 / diff" 时，你只发表你的看法，让别的 Agent 自己说他们的。\n` +
      `- 即使其他 Agent 还没回复，也不要替他们设想或代笔。`
    );
  }

  private resolveAdapter(agentId: string): string {
    // 1. If the mention matches a registered adapter id, use it directly.
    if (this.registry.has(agentId)) return agentId;
    // 2. Otherwise fall back to preference list.
    const preference = ['deepseek-v3', 'claude-code', 'codex', 'doubao', 'mock'];
    for (const id of preference) if (this.registry.has(id)) return id;
    return 'mock';
  }

  private async invokeAgent(args: {
    adapterId: string;
    /** All adapters the user @-mentioned in this turn (includes self). */
    peerAdapterIds: string[];
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

    const adapter: AgentAdapter = this.registry.get(args.adapterId);
    const msgId = cryptoRandomId();
    const req: ChatRequest = {
      taskId: msgId,
      systemPrompt: this.buildSystemPrompt(args.adapterId, args.peerAdapterIds),
      messages: [{ role: 'user', content: args.userText }],
      metadata: { purpose: 'chat', agentId: args.adapterId },
    };

    args.send({
      op: 'msg_started',
      message: {
        id: msgId,
        conversationId: args.conversationId,
        senderType: 'agent',
        senderId: args.adapterId,
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
          senderId: args.adapterId,
          text: assembled,
        })
        .catch((e) => console.warn('[mention-router] persist agent msg failed', e));
    }
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
