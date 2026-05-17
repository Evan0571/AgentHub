import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agentCalls, type Db } from '@agenthub/db';
import { DB_TOKEN } from './constants.js';

export interface UsageRecordInput {
  conversationId: string | null;
  adapterId: string;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  /** Float USD; stored *10000 in `cost_usd_centi` to avoid float columns. */
  costUsd: number;
  latencyMs: number;
  status: string;
  errorCode?: string | null;
}

export interface ModelUsageRow {
  adapterId: string;
  model: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ConversationUsageSummary {
  conversationId: string;
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  byModel: ModelUsageRow[];
}

@Injectable()
export class UsageRepo {
  private readonly log = new Logger('UsageRepo');

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async record(input: UsageRecordInput): Promise<void> {
    try {
      await this.db.insert(agentCalls).values({
        conversationId: input.conversationId,
        adapterId: input.adapterId,
        model: input.model,
        promptTokens: Math.max(0, Math.round(input.promptTokens || 0)),
        completionTokens: Math.max(0, Math.round(input.completionTokens || 0)),
        costUsd: Math.max(0, Math.round((input.costUsd || 0) * 10_000)),
        latencyMs: Math.max(0, Math.round(input.latencyMs || 0)),
        status: input.status.slice(0, 40),
        errorCode: input.errorCode ?? null,
      });
    } catch (e) {
      // Usage accounting must never break the chat path.
      this.log.warn(`record failed: ${(e as Error).message}`);
    }
  }

  /** Per-model aggregation for one conversation. */
  async summaryForConversation(conversationId: string): Promise<ConversationUsageSummary> {
    const rows = await this.db
      .select({
        adapterId: agentCalls.adapterId,
        model: agentCalls.model,
        calls: sql<number>`count(*)::int`,
        promptTokens: sql<number>`coalesce(sum(${agentCalls.promptTokens}),0)::int`,
        completionTokens: sql<number>`coalesce(sum(${agentCalls.completionTokens}),0)::int`,
        costCenti: sql<number>`coalesce(sum(${agentCalls.costUsd}),0)::bigint`,
      })
      .from(agentCalls)
      .where(eq(agentCalls.conversationId, conversationId))
      .groupBy(agentCalls.adapterId, agentCalls.model)
      .orderBy(desc(sql`coalesce(sum(${agentCalls.costUsd}),0)`));

    const byModel: ModelUsageRow[] = rows.map((r) => ({
      adapterId: r.adapterId,
      model: r.model,
      calls: Number(r.calls),
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
      totalTokens: Number(r.promptTokens) + Number(r.completionTokens),
      costUsd: Number(r.costCenti) / 10_000,
    }));

    const totals = byModel.reduce(
      (acc, m) => ({
        calls: acc.calls + m.calls,
        promptTokens: acc.promptTokens + m.promptTokens,
        completionTokens: acc.completionTokens + m.completionTokens,
        totalTokens: acc.totalTokens + m.totalTokens,
        costUsd: acc.costUsd + m.costUsd,
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
    );

    return { conversationId, totals, byModel };
  }

  /** Recent raw calls (debugging / future detail view). */
  async recentForConversation(conversationId: string, limit = 50) {
    return this.db
      .select()
      .from(agentCalls)
      .where(and(eq(agentCalls.conversationId, conversationId)))
      .orderBy(desc(agentCalls.createdAt))
      .limit(Math.min(200, Math.max(1, limit)));
  }
}
