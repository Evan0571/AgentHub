import { Module } from '@nestjs/common';
import { ConversationGateway } from './conversation.gateway.js';
import { ConversationService } from './conversation.service.js';
import { MentionRouter } from './mention-router.js';
import { ReplayService } from './replay.service.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';

@Module({
  imports: [OrchestratorModule],
  providers: [ConversationGateway, ConversationService, MentionRouter, ReplayService],
  exports: [ConversationService],
})
export class ConversationModule {}
