import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  agents,
  conversations,
  conversationMembers,
  type Db,
} from '@agenthub/db';
import { DB_TOKEN, DEMO_USER_ID } from './constants.js';

export interface ConversationSummary {
  id: string;
  type: 'single' | 'group';
  title: string;
  groupSystemPrompt: string | null;
  members: MemberDescriptor[];
  createdAt: string;
}

export interface MemberDescriptor {
  agentId: string;
  name: string;
  adapterId: string;
  avatarColor: string;
  systemPrompt: string | null;
  role: 'admin' | 'member' | 'muted';
}

@Injectable()
export class ConversationsRepo {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async listForUser(userId = DEMO_USER_ID): Promise<ConversationSummary[]> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.ownerUserId, userId))
      .orderBy(desc(conversations.updatedAt));
    return Promise.all(rows.map((r) => this.toSummary(r)));
  }

  async getById(id: string): Promise<ConversationSummary | null> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    const r = rows[0];
    return r ? this.toSummary(r) : null;
  }

  async create(input: {
    id?: string;
    type: 'single' | 'group';
    title: string;
    groupSystemPrompt?: string | null;
    memberAgentIds: string[];
    ownerUserId?: string;
  }): Promise<ConversationSummary> {
    const id = input.id ?? crypto.randomUUID();
    await this.db.insert(conversations).values({
      id,
      type: input.type,
      title: input.title,
      groupSystemPrompt: input.groupSystemPrompt ?? null,
      ownerUserId: input.ownerUserId ?? DEMO_USER_ID,
    });
    if (input.memberAgentIds.length > 0) {
      await this.db.insert(conversationMembers).values(
        input.memberAgentIds.map((agentId) => ({
          conversationId: id,
          agentId,
          role: 'member' as const,
        })),
      );
    }
    return (await this.getById(id))!;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(conversations).where(eq(conversations.id, id));
  }

  async addMember(conversationId: string, agentId: string): Promise<void> {
    // ignore duplicate-PK conflict by checking first.
    const exists = await this.db
      .select({ agentId: conversationMembers.agentId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.agentId, agentId),
        ),
      )
      .limit(1);
    if (exists.length > 0) return;
    await this.db.insert(conversationMembers).values({
      conversationId,
      agentId,
      role: 'member',
    });
  }

  async removeMember(conversationId: string, agentId: string): Promise<void> {
    await this.db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.agentId, agentId),
        ),
      );
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(eq(conversations.id, id));
  }

  async updateGroupSystemPrompt(id: string, groupSystemPrompt: string | null): Promise<void> {
    await this.db
      .update(conversations)
      .set({ groupSystemPrompt, updatedAt: new Date() })
      .where(eq(conversations.id, id));
  }

  private async toSummary(
    r: typeof conversations.$inferSelect,
  ): Promise<ConversationSummary> {
    const memberRows = await this.db
      .select({
        agentId: conversationMembers.agentId,
        role: conversationMembers.role,
        name: agents.name,
        adapterId: agents.adapterId,
        avatarColor: agents.avatarColor,
        systemPrompt: agents.systemPrompt,
      })
      .from(conversationMembers)
      .innerJoin(agents, eq(agents.id, conversationMembers.agentId))
      .where(eq(conversationMembers.conversationId, r.id));
    return {
      id: r.id,
      type: r.type as 'single' | 'group',
      title: r.title,
      groupSystemPrompt: r.groupSystemPrompt,
      members: memberRows.map((m) => ({
        agentId: m.agentId,
        name: m.name,
        adapterId: m.adapterId,
        avatarColor: m.avatarColor,
        systemPrompt: m.systemPrompt,
        role: m.role as 'admin' | 'member' | 'muted',
      })),
      createdAt: r.createdAt.toISOString(),
    };
  }
}
