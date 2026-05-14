import { Injectable, Logger } from '@nestjs/common';
import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';
import { MessagesRepo } from '../db/messages.repo.js';

/**
 * Conversation persistence. The client renders its own user message instantly
 * for snappy UX, so we never echo it back — this service's job is to persist
 * it (so reloads can hydrate) and let mention-router fire downstream agents.
 */
@Injectable()
export class ConversationService {
  private readonly log = new Logger('ConversationService');

  constructor(private readonly messages: MessagesRepo) {}

  async handleUserMessage(
    event: Extract<ClientEvent, { op: 'user_msg' }>,
    _send: (e: ServerEvent) => void,
  ): Promise<void> {
    if (event.content.kind !== 'text') return;
    try {
      await this.messages.insert({
        conversationSlug: event.conversationId,
        senderType: 'user',
        senderId: 'me',
        text: event.content.text,
      });
    } catch (e) {
      this.log.warn(`persist user msg failed: ${(e as Error).message}`);
    }
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
