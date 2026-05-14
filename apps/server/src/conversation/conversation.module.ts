import { Module } from '@nestjs/common';
import { ConversationGateway } from './conversation.gateway.js';
import { ConversationService } from './conversation.service.js';
import { ConversationController } from './conversation.controller.js';
import { MentionRouter } from './mention-router.js';
import { ReplayService } from './replay.service.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { DeployModule } from '../deploy/deploy.module.js';

@Module({
  imports: [OrchestratorModule, DeployModule],
  providers: [ConversationGateway, ConversationService, MentionRouter, ReplayService],
  controllers: [ConversationController],
  exports: [ConversationService],
})
export class ConversationModule {}
