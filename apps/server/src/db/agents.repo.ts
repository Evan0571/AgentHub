import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, or } from 'drizzle-orm';
import { agents, type Db } from '@agenthub/db';
import { DB_TOKEN, DEMO_USER_ID } from './constants.js';
import { decryptSecret, encryptSecret } from '../crypto/crypto.util.js';

/** Public, client-safe agent descriptor — never carries the raw API key. */
export interface AgentDescriptor {
  id: string;
  name: string;
  adapterId: string;
  model: string | null;
  systemPrompt: string;
  avatarColor: string;
  isPublic: boolean;
  ownerUserId: string | null;
  baseUrl: string | null;
  /** True if the agent has a BYOK API key stored. The key itself never leaves the server. */
  hasApiKey: boolean;
  createdAt: string;
}

/** Internal-only view: includes the decrypted API key. Use only when invoking adapters. */
export interface AgentWithSecrets extends AgentDescriptor {
  apiKey: string | null;
}

@Injectable()
export class AgentsRepo {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Returns built-in (public) agents + current user's private agents. */
  async listAvailable(userId = DEMO_USER_ID): Promise<AgentDescriptor[]> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(or(eq(agents.isPublic, true), eq(agents.ownerUserId, userId)))
      .orderBy(desc(agents.isPublic), desc(agents.createdAt));
    return rows.map((r) => this.toDescriptor(r));
  }

  async getById(id: string): Promise<AgentDescriptor | null> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ? this.toDescriptor(rows[0]) : null;
  }

  /** Server-only — returns the full row with the decrypted API key. */
  async getByIdWithSecrets(id: string): Promise<AgentWithSecrets | null> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!rows[0]) return null;
    const row = rows[0];
    let apiKey: string | null = null;
    if (row.apiKeyEncrypted) {
      try {
        apiKey = decryptSecret(row.apiKeyEncrypted);
      } catch (e) {
        console.warn(`[agents.repo] failed to decrypt apiKey for ${id}: ${(e as Error).message}`);
      }
    }
    return { ...this.toDescriptor(row), apiKey };
  }

  async create(input: {
    id?: string;
    name: string;
    adapterId: string;
    model?: string | null;
    systemPrompt: string;
    avatarColor: string;
    isPublic?: boolean;
    ownerUserId?: string | null;
    apiKey?: string | null;
    baseUrl?: string | null;
  }): Promise<AgentDescriptor> {
    const id = input.id ?? crypto.randomUUID();
    const apiKeyEncrypted = input.apiKey ? encryptSecret(input.apiKey) : null;
    await this.db.insert(agents).values({
      id,
      name: input.name,
      adapterId: input.adapterId,
      model: input.model ?? null,
      systemPrompt: input.systemPrompt,
      avatarColor: input.avatarColor,
      isPublic: input.isPublic ?? false,
      ownerUserId: input.ownerUserId === undefined ? DEMO_USER_ID : input.ownerUserId,
      apiKeyEncrypted,
      baseUrl: input.baseUrl ?? null,
    });
    return (await this.getById(id))!;
  }

  async update(
    id: string,
    patch: Partial<{
      name: string;
      systemPrompt: string;
      avatarColor: string;
      model: string | null;
      baseUrl: string | null;
      /** Pass empty string to CLEAR the saved key; null/undefined leaves it untouched. */
      apiKey: string | null;
    }>,
  ): Promise<AgentDescriptor | null> {
    const dbPatch: Record<string, unknown> = {};
    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.systemPrompt !== undefined) dbPatch.systemPrompt = patch.systemPrompt;
    if (patch.avatarColor !== undefined) dbPatch.avatarColor = patch.avatarColor;
    if (patch.model !== undefined) dbPatch.model = patch.model;
    if (patch.baseUrl !== undefined) dbPatch.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined) {
      // null or '' → clear; otherwise re-encrypt
      dbPatch.apiKeyEncrypted = patch.apiKey ? encryptSecret(patch.apiKey) : null;
    }
    if (Object.keys(dbPatch).length === 0) return this.getById(id);
    await this.db.update(agents).set(dbPatch).where(eq(agents.id, id));
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.id, id));
  }

  /** Idempotent built-in agent seeding. */
  async ensureBuiltIn(input: {
    id: string;
    name: string;
    adapterId: string;
    avatarColor: string;
    systemPrompt?: string;
  }): Promise<void> {
    const rows = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.id))
      .limit(1);
    if (rows.length > 0) return;
    await this.db.insert(agents).values({
      id: input.id,
      name: input.name,
      adapterId: input.adapterId,
      systemPrompt: input.systemPrompt ?? '',
      avatarColor: input.avatarColor,
      isPublic: true,
      ownerUserId: null,
    });
  }

  /** Existence check that also accepts the well-known orchestrator pseudo-agent. */
  async exists(id: string): Promise<boolean> {
    if (id === 'orchestrator') return true;
    const rows = await this.db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).limit(1);
    return rows.length > 0;
  }

  private toDescriptor(r: typeof agents.$inferSelect): AgentDescriptor {
    return {
      id: r.id,
      name: r.name,
      adapterId: r.adapterId,
      model: r.model,
      systemPrompt: r.systemPrompt,
      avatarColor: r.avatarColor,
      isPublic: r.isPublic,
      ownerUserId: r.ownerUserId,
      baseUrl: r.baseUrl,
      hasApiKey: !!r.apiKeyEncrypted,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
