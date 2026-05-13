import { Injectable } from '@nestjs/common';
import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';

/**
 * Conversation persistence + recall + patch decision.
 * TODO: wire Drizzle from @agenthub/db once DATABASE_URL is configured.
 */
@Injectable()
export class ConversationService {
  async handleUserMessage(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    _send: (e: ServerEvent) => void,
  ): Promise<void> {
    // The client renders its own user message instantly for snappy UX,
    // so we don't echo it back. This method's job is just to persist
    // (TODO: write to DB) and let mention-router fire downstream agents.
    void event;
  }

  async handlePatchDecision(
    event: Extract<ClientEvent, { op: 'accept_patch' | 'reject_patch' }>,
    _send: (e: ServerEvent) => void,
  ): Promise<void> {
    // TODO: move workspace HEAD forward on accept; keep snapshot untouched on reject.
    void event;
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
