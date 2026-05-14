import { Inject, Injectable } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { messages, conversations, type Db } from '@agenthub/db';
import { DB_TOKEN, SLUG_TO_UUID, UUID_TO_SLUG } from './constants.js';

export interface PersistedMessage {
  id: string;
  conversationSlug: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  text: string;
  createdAt: string;
}

@Injectable()
export class MessagesRepo {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Map a client-facing slug (c1/c2/c3) or raw UUID to the canonical UUID. */
  resolveConversationUuid(slugOrUuid: string): string | null {
    if (SLUG_TO_UUID[slugOrUuid]) return SLUG_TO_UUID[slugOrUuid];
    // Already a UUID? Accept as-is.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrUuid)) {
      return slugOrUuid;
    }
    return null;
  }

  /** Inverse — DB UUID back to client slug for response payloads. */
  toSlug(uuid: string): string {
    return UUID_TO_SLUG[uuid] ?? uuid;
  }

  async insert(input: {
    conversationSlug: string;
    senderType: 'user' | 'agent' | 'system';
    senderId: string;
    text: string;
  }): Promise<void> {
    const convId = this.resolveConversationUuid(input.conversationSlug);
    if (!convId) return; // unknown conversation — skip silently
    await this.db.insert(messages).values({
      conversationId: convId,
      senderType: input.senderType,
      senderId: input.senderId,
      contentType: 'text',
      body: { kind: 'text', text: input.text },
    });
  }

  async list(conversationSlugOrUuid: string, limit = 500): Promise<PersistedMessage[]> {
    const convId = this.resolveConversationUuid(conversationSlugOrUuid);
    if (!convId) return [];
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(asc(messages.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      conversationSlug: this.toSlug(r.conversationId),
      senderType: r.senderType as 'user' | 'agent' | 'system',
      senderId: r.senderId,
      text: extractText(r.body),
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

function extractText(body: unknown): string {
  if (body && typeof body === 'object' && 'text' in (body as Record<string, unknown>)) {
    const t = (body as { text?: unknown }).text;
    return typeof t === 'string' ? t : '';
  }
  return '';
}
