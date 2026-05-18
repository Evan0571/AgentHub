import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { WebSocket, Server } from 'ws';
import { PROJECT_PLANNER_MENTION, type ClientEvent, type ServerEvent } from '@agenthub/shared-types';
import { ConversationService } from './conversation.service.js';
import { MentionRouter } from './mention-router.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { ReplayService } from './replay.service.js';
import { DeployService } from '../deploy/deploy.service.js';

/**
 * Single WS endpoint that multiplexes all chat events.
 * Mapping to PRD §8.1 — keep this thin; complex logic lives in services.
 */
@WebSocketGateway({ path: '/ws', cors: true })
@Injectable()
export class ConversationGateway {
  @WebSocketServer() server!: Server;
  private readonly seenClientEventIds = new Set<string>();
  private readonly seenClientEventOrder: string[] = [];

  private readonly conv: ConversationService;
  private readonly mention: MentionRouter;
  private readonly orchestrator: OrchestratorService;
  private readonly replay: ReplayService;
  private readonly deploy: DeployService;

  constructor(
    conv: ConversationService,
    mention: MentionRouter,
    orchestrator: OrchestratorService,
    replay: ReplayService,
    deploy: DeployService,
  ) {
    this.conv = conv;
    this.mention = mention;
    this.orchestrator = orchestrator;
    this.replay = replay;
    this.deploy = deploy;
  }

  @SubscribeMessage('client_event')
  async onClientEvent(
    @MessageBody() event: ClientEvent,
    @ConnectedSocket() socket: WebSocket,
  ): Promise<void> {
    const send = (e: ServerEvent) => socket.send(JSON.stringify({ event: 'server_event', data: e }));

    switch (event.op) {
      case 'user_msg':
        if (event.clientEventId) {
          send({ op: 'client_event_ack', clientEventId: event.clientEventId });
          if (this.seenClientEventIds.has(event.clientEventId)) return;
          this.rememberClientEvent(event.clientEventId);
        }
        await this.conv.handleUserMessage(event, send);
        await this.mention.route(event, send, this.orchestrator);
        return;
      case 'answer_user_question': {
        const resumed: Extract<ClientEvent, { op: 'user_msg' }> = {
          op: 'user_msg',
          conversationId: event.conversationId,
          content: {
            kind: 'text',
            text: formatQuestionAnswerResume(event.resumePrompt, event.answers),
          },
          mentions: [PROJECT_PLANNER_MENTION],
        };
        await this.conv.handleUserMessage(resumed, send);
        await this.mention.route(resumed, send, this.orchestrator);
        return;
      }
      case 'cancel':
        await this.orchestrator.cancel(event.taskId);
        return;
      case 'accept_patch':
      case 'reject_patch':
        await this.conv.handlePatchDecision(event, send);
        return;
      case 'edit_plan':
        await this.orchestrator.applyPlanEdits(event, send);
        return;
      case 'retry_task':
        await this.orchestrator.retryTask(event, send);
        return;
      case 'pause_plan':
        await this.orchestrator.pause(event.planId);
        return;
      case 'resume_plan':
        await this.orchestrator.resume(event.planId);
        return;
      case 'suggest_deps':
        await this.orchestrator.suggestDeps(event, send);
        return;
      case 'deploy':
        await this.deploy.deploy(event, send);
        return;
      case 'replay_request':
        await this.replay.stream(event, send);
        return;
    }
  }

  private rememberClientEvent(id: string): void {
    this.seenClientEventIds.add(id);
    this.seenClientEventOrder.push(id);
    while (this.seenClientEventOrder.length > 2000) {
      const oldest = this.seenClientEventOrder.shift();
      if (oldest) this.seenClientEventIds.delete(oldest);
    }
  }
}

function formatQuestionAnswerResume(
  resumePrompt: string,
  answers: Extract<ClientEvent, { op: 'answer_user_question' }>['answers'],
): string {
  const lines = [
    resumePrompt.trim(),
    '',
    '用户已回答澄清问题：',
    ...answers.map((item) => {
      const suffix = item.notes ? `；补充：${item.notes}` : '';
      return `- ${item.question} => ${item.answer}${suffix}`;
    }),
    '',
    '请基于这些明确选择继续推进。不要再次询问已经回答的问题；如果仍有高代价歧义，再发起新的结构化问题。',
  ];
  return lines.filter(Boolean).join('\n');
}
