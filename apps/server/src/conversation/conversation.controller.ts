import { Controller, Get, Param } from '@nestjs/common';
import type { Plan } from '@agenthub/shared-types';
import { MessagesRepo, type PersistedMessage } from '../db/messages.repo.js';
import { PlanService } from '../orchestrator/plan.service.js';

export interface ConversationStateResponse {
  conversationId: string;
  messages: PersistedMessage[];
  plan: Plan | null;
}

/** REST hydration endpoint for the client on page load / conversation switch. */
@Controller('api/conversations')
export class ConversationController {
  constructor(
    private readonly messages: MessagesRepo,
    private readonly plans: PlanService,
  ) {}

  @Get(':id/state')
  async getState(@Param('id') id: string): Promise<ConversationStateResponse> {
    const [msgs, plan] = await Promise.all([
      this.messages.list(id),
      this.plans.latestForConversation(id),
    ]);
    return {
      conversationId: id,
      messages: msgs,
      plan: plan ?? null,
    };
  }
}
