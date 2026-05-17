import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { plans, type Db } from '@agenthub/db';
import type { Plan } from '@agenthub/shared-types';
import { DB_TOKEN, SLUG_TO_UUID } from './constants.js';

@Injectable()
export class PlansRepo {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  private resolveConv(slugOrUuid: string): string | null {
    if (SLUG_TO_UUID[slugOrUuid]) return SLUG_TO_UUID[slugOrUuid];
    if (/^[0-9a-f]{8}-/i.test(slugOrUuid)) return slugOrUuid;
    return null;
  }

  /** Upsert by plan.id. Stores the entire Plan as JSONB for v1 simplicity. */
  async upsert(plan: Plan): Promise<void> {
    const convId = this.resolveConv(plan.conversationId);
    if (!convId) return;
    // Normalize the plan we store so DB always has the latest conversationId form.
    const dagToStore = { ...plan, conversationId: plan.conversationId };
    await this.db
      .insert(plans)
      .values({
        id: plan.id,
        conversationId: convId,
        rootGoal: plan.rootGoal,
        status: plan.status,
        dag: dagToStore as unknown as object,
        version: plan.version,
        createdAt: new Date(plan.createdAt),
        updatedAt: new Date(plan.updatedAt),
      })
      .onConflictDoUpdate({
        target: plans.id,
        set: {
          conversationId: convId,
          rootGoal: plan.rootGoal,
          status: plan.status,
          dag: dagToStore as unknown as object,
          version: plan.version,
          updatedAt: new Date(plan.updatedAt),
        },
      });
  }

  async getById(planId: string): Promise<Plan | undefined> {
    const rows = await this.db
      .select({ dag: plans.dag })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    const r = rows[0];
    if (!r) return undefined;
    return r.dag as unknown as Plan;
  }

  /** Latest plan for a conversation (most recent updatedAt). */
  async latestForConversation(slugOrUuid: string): Promise<Plan | undefined> {
    const convId = this.resolveConv(slugOrUuid);
    if (!convId) return undefined;
    const rows = await this.db
      .select({ dag: plans.dag })
      .from(plans)
      .where(eq(plans.conversationId, convId))
      .orderBy(desc(plans.updatedAt))
      .limit(1);
    const r = rows[0];
    if (!r) return undefined;
    return r.dag as unknown as Plan;
  }
}
