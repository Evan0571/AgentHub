import { Injectable } from '@nestjs/common';
import type { AgentAdapter, ChatRequest } from '@agenthub/adapter-core';
import type { ServerEvent } from '@agenthub/shared-types';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import { AgentsRepo } from '../db/agents.repo.js';
import { ConversationsRepo, type ConversationSummary, type MemberDescriptor } from '../db/conversations.repo.js';
import { MessagesRepo } from '../db/messages.repo.js';
import { AgentToolRunnerService } from '../workspace/agent-tool-runner.service.js';
import { WorkspaceService, type TeamMailboxMessage, type TeamWakeRequest } from '../workspace/workspace.service.js';

const MAX_WAKE_ITEMS_PER_PASS = 4;
const WAKE_CLAIM_STALE_MS = 5 * 60 * 1000;

interface WakeProcessOptions {
  reason?: string;
  maxItems?: number;
}

interface ResolvedWakeTarget {
  member: MemberDescriptor;
  message: TeamMailboxMessage;
  wake: TeamWakeRequest;
  conversation: ConversationSummary;
  workspaceConversationId: string;
}

@Injectable()
export class TeamWakeService {
  private readonly running = new Set<string>();
  private readonly runningTargets = new Set<string>();

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly conversations: ConversationsRepo,
    private readonly agents: AgentsRepo,
    private readonly messages: MessagesRepo,
    private readonly adapterFactory: AdapterFactoryService,
    private readonly toolRunner: AgentToolRunnerService,
  ) {}

  async processPending(
    conversationId: string,
    send: (event: ServerEvent) => void,
    options: WakeProcessOptions = {},
  ): Promise<void> {
    if (this.running.has(conversationId)) return;
    this.running.add(conversationId);
    try {
      await this.workspace.recoverStaleTeamWakeClaims(conversationId, {
        staleMs: WAKE_CLAIM_STALE_MS,
      });
      const maxItems = Math.max(1, Math.min(options.maxItems ?? MAX_WAKE_ITEMS_PER_PASS, 12));
      for (let processed = 0; processed < maxItems; processed++) {
        const next = await this.nextWake(conversationId);
        if (!next) return;
        await this.invokeWake(next, send, options.reason);
      }
    } finally {
      this.running.delete(conversationId);
    }
  }

  private async nextWake(conversationId: string): Promise<ResolvedWakeTarget | null> {
    const realConversationId = this.messages.resolveConversationUuid(conversationId) ?? conversationId;
    const conversation = await this.conversations.getById(realConversationId);
    if (!conversation) return null;

    const wakeups = await this.workspace.listTeamWakeQueue(conversationId, {
      includeResolved: false,
      limit: 20,
    });
    for (const wake of wakeups.wakeups) {
      if (wake.nextRunAt && Date.parse(wake.nextRunAt) > Date.now()) continue;
      const member = resolveWakeMember(wake.target, conversation.members);
      if (!member) {
        if (!isBroadcastTarget(wake.target)) {
          await this.workspace.resolveTeamWake(conversationId, {
            wakeId: wake.id,
            status: 'cancelled',
          });
        }
        continue;
      }
      const mailbox = await this.workspace.readTeamMailbox(conversationId, {
        recipient: wake.target,
        includeRead: true,
        limit: 200,
      });
      const message = mailbox.messages.find((item) => item.id === wake.messageId);
      if (!message) {
        await this.workspace.resolveTeamWake(conversationId, {
          wakeId: wake.id,
          status: 'cancelled',
          agentId: member.agentId,
          agentName: member.name,
        });
        continue;
      }
      if (this.runningTargets.has(targetRunKey(conversationId, member.agentId))) continue;
      return { conversation, member, message, wake, workspaceConversationId: conversationId };
    }
    return null;
  }

  private async invokeWake(
    target: ResolvedWakeTarget,
    send: (event: ServerEvent) => void,
    reason: string | undefined,
  ): Promise<void> {
    const { conversation, member, message, wake, workspaceConversationId } = target;
    const runKey = targetRunKey(workspaceConversationId, member.agentId);
    if (this.runningTargets.has(runKey)) return;
    this.runningTargets.add(runKey);
    try {
    await this.workspace.resolveTeamWake(workspaceConversationId, {
      wakeId: wake.id,
      status: 'claimed',
      agentId: member.agentId,
      agentName: member.name,
    });

    const full = await this.agents.getByIdWithSecrets(member.agentId);
    const adapter: AgentAdapter = this.adapterFactory.resolveForAgent({
      agentId: member.agentId,
      adapterId: member.adapterId,
      model: full?.model ?? null,
      apiKey: full?.apiKey ?? null,
      baseUrl: full?.baseUrl ?? null,
    });

    const msgId = cryptoRandomId();
    const userContent = renderWakePrompt(message, wake, reason);
    const request: ChatRequest = {
      taskId: msgId,
      systemPrompt: renderWakeSystemPrompt(member, conversation),
      messages: [{ role: 'user', content: userContent }],
      workspace: {
        id: workspaceConversationId,
        snapshotId: 'head',
      },
      metadata: {
        purpose: 'team_wake',
        wakeId: wake.id,
        messageId: message.id,
        agentId: member.agentId,
        adapterId: member.adapterId,
        agentName: member.name,
      },
    };

    send({
      op: 'msg_started',
      message: {
        id: msgId,
        conversationId: workspaceConversationId,
        senderType: 'agent',
        senderId: member.agentId,
        createdAt: new Date().toISOString(),
      },
    });
    send({
      op: 'msg_thinking',
      msgId,
      delta: `\nTeam wake: ${message.subject}\n`,
    });

    const run = await this.toolRunner.run({
      adapter,
      request,
      conversationId: workspaceConversationId,
      msgId,
      send,
      maxToolRounds: 24,
    });

    if (run.errored) {
      await this.workspace.recordTeamWakeFailure(workspaceConversationId, {
        wakeId: wake.id,
        error: run.error?.message ?? 'wake agent run failed',
        agentId: member.agentId,
        agentName: member.name,
      });
      return;
    }

    if (run.output.trim()) {
      await this.messages.insert({
        conversationSlug: workspaceConversationId,
        senderType: 'agent',
        senderId: member.agentId,
        text: run.output,
      });
    }

    await this.workspace.markTeamMessagesRead(workspaceConversationId, { ids: [message.id] });
    await this.workspace.resolveTeamWake(workspaceConversationId, {
      wakeId: wake.id,
      status: 'resolved',
      agentId: member.agentId,
      agentName: member.name,
    });
    } catch (error) {
      await this.workspace.recordTeamWakeFailure(workspaceConversationId, {
        wakeId: wake.id,
        error: error instanceof Error ? error.message : String(error),
        agentId: member.agentId,
        agentName: member.name,
      });
    } finally {
      this.runningTargets.delete(runKey);
    }
  }
}

function renderWakeSystemPrompt(member: MemberDescriptor, conversation: ConversationSummary): string {
  return [
    `You are ${member.name}, a teammate in AgentHub.`,
    '',
    'You were automatically woken because another agent sent you a directed handoff.',
    'Treat this as real work, not a chat notification. Inspect `team_message_list`, `task_board_list`, and `memory_context` if needed, then either act in the workspace or leave a concrete handoff/blocker.',
    'Before your final response, do a memory review: if the handoff changed a durable product decision, shared contract, env variable, schema, Docker/database setup, local caveat, or role learning, call `memory_note` first. If the handoff only requires acknowledgement, keep the response short and update shared memory/task board only when a durable fact changed.',
    '',
    conversation.groupSystemPrompt ? `Conversation rules:\n${conversation.groupSystemPrompt}` : '',
    '',
    'Do not use emoji. Do not claim work is complete unless files, commands, or explicit reasoning support it.',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderWakePrompt(
  message: TeamMailboxMessage,
  wake: TeamWakeRequest,
  reason: string | undefined,
): string {
  return [
    `Team wake reason: ${reason ?? 'directed teammate handoff'}`,
    `Wake id: ${wake.id}`,
    `Message id: ${message.id}`,
    message.taskId ? `Task id: ${message.taskId}` : '',
    `From: ${message.fromAgentName}`,
    `To: ${message.to}`,
    `Priority: ${message.priority}`,
    `Subject: ${message.subject}`,
    '',
    message.body,
    '',
    'If you perform work, update task_board_update and/or memory_note as appropriate. If this changes an API, schema, env variable, Docker service, or shared file contract, send a directed teammate message to affected roles.',
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveWakeMember(target: string, members: MemberDescriptor[]): MemberDescriptor | null {
  if (isBroadcastTarget(target)) return null;
  const needle = normalizeTarget(target);
  const visible = members.filter((member) => member.agentId !== 'orchestrator' && member.agentId !== 'mock');
  return (
    visible.find((member) => normalizeTarget(member.agentId) === needle) ??
    visible.find((member) => normalizeTarget(member.name) === needle) ??
    visible.find((member) => normalizeTarget(shortAgentId(member.agentId)) === needle) ??
    visible.find((member) => normalizeTarget(member.agentId).endsWith(`-${needle}`)) ??
    visible.find((member) => normalizeTarget(`${member.name} ${member.systemPrompt ?? ''}`).includes(needle)) ??
    null
  );
}

function isBroadcastTarget(target: string): boolean {
  const normalized = normalizeTarget(target);
  return normalized === 'team' || normalized === 'all' || normalized === '*';
}

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, '').replace(/\s+/g, '-');
}

function shortAgentId(agentId: string): string {
  const match = /^conv-agent-[0-9a-fA-F-]{36}-(.+)$/.exec(agentId);
  return match?.[1] ?? agentId;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function targetRunKey(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`;
}
