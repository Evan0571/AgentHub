import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { WebSocket, Server } from 'ws';
import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';
import { ConversationService } from './conversation.service.js';
import { MentionRouter } from './mention-router.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { ReplayService } from './replay.service.js';

/**
 * Single WS endpoint that multiplexes all chat events.
 * Mapping to PRD §8.1 — keep this thin; complex logic lives in services.
 */
@WebSocketGateway({ path: '/ws', cors: true })
@Injectable()
export class ConversationGateway {
  @WebSocketServer() server!: Server;

  private readonly conv: ConversationService;
  private readonly mention: MentionRouter;
  private readonly orchestrator: OrchestratorService;
  private readonly replay: ReplayService;

  constructor(
    conv: ConversationService,
    mention: MentionRouter,
    orchestrator: OrchestratorService,
    replay: ReplayService,
  ) {
    this.conv = conv;
    this.mention = mention;
    this.orchestrator = orchestrator;
    this.replay = replay;
  }

  @SubscribeMessage('client_event')
  async onClientEvent(
    @MessageBody() event: ClientEvent,
    @ConnectedSocket() socket: WebSocket,
  ): Promise<void> {
    const send = (e: ServerEvent) => socket.send(JSON.stringify({ event: 'server_event', data: e }));

    switch (event.op) {
      case 'user_msg':
        await this.conv.handleUserMessage(event, send);
        await this.mention.route(event, send, this.orchestrator);
        return;
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
      case 'pause_plan':
        await this.orchestrator.pause(event.planId);
        return;
      case 'resume_plan':
        await this.orchestrator.resume(event.planId);
        return;
      case 'replay_request':
        await this.replay.stream(event, send);
        return;
    }
  }
}
