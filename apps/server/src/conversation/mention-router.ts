import { Inject, Injectable } from '@nestjs/common';
import type { AgentAdapter, AdapterRegistry, ChatRequest } from '@agenthub/adapter-core';
import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';
import { ADAPTER_REGISTRY } from '../adapter/adapter.module.js';
import type { OrchestratorService } from '../orchestrator/orchestrator.service.js';

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
4. 中文回复（除非用户用英文提问）。简洁、有结论先行。`;

@Injectable()
export class MentionRouter {
  constructor(@Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry) {}

  async route(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    send: (e: ServerEvent) => void,
    orchestrator: OrchestratorService,
  ): Promise<void> {
    if (event.mentions.length === 0) return;

    // If user explicitly invokes Orchestrator (mention "@orchestrator"),
    // delegate the goal to it instead of a single agent.
    if (event.mentions.includes('orchestrator')) {
      const text = event.content.kind === 'text' ? event.content.text : '';
      await orchestrator.plan({ conversationId: event.conversationId, rootGoal: text }, send);
      return;
    }

    await Promise.all(
      event.mentions.map((agentId) =>
        this.invokeAgent({
          adapterId: this.resolveAdapter(agentId),
          conversationId: event.conversationId,
          userText: event.content.kind === 'text' ? event.content.text : '',
          hop: 0,
          send,
        }),
      ),
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
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: args.userText }],
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

    for await (const ev of adapter.chat(req)) {
      switch (ev.type) {
        case 'token':
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
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
