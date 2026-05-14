import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { users, conversations, messages, type Db } from '@agenthub/db';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, DEMO_USER_ID, DEMO_USER_EMAIL, SLUG_TO_UUID } from './constants.js';

type SeedConversationKey = 'c1' | 'c2' | 'c3';

const SEED_CONV: Record<SeedConversationKey, { id: string; title: string }> = {
  c1: { id: SLUG_TO_UUID.c1!, title: '我 + DeepSeek V3' },
  c2: { id: SLUG_TO_UUID.c2!, title: '待办应用工程群' },
  c3: { id: SLUG_TO_UUID.c3!, title: '我 + DeepSeek R1（带思考链）' },
};

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly log = new Logger('SeedService');

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureDemoUser();
    for (const [slug, info] of Object.entries(SEED_CONV)) {
      await this.ensureConversation(info.id, slug as SeedConversationKey, info.title);
    }
    this.log.log('seed complete');
  }

  private async ensureDemoUser(): Promise<void> {
    const found = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, DEMO_USER_ID))
      .limit(1);
    if (found.length > 0) return;
    await this.db.insert(users).values({
      id: DEMO_USER_ID,
      email: DEMO_USER_EMAIL,
    });
    this.log.log(`inserted demo user ${DEMO_USER_ID}`);
  }

  private async ensureConversation(id: string, slug: SeedConversationKey, title: string): Promise<void> {
    const found = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (found.length > 0) return;
    await this.db.insert(conversations).values({
      id,
      type: slug === 'c2' ? 'group' : 'single',
      title,
      ownerUserId: DEMO_USER_ID,
    });
    // Add the intro system message so first-time loads have something visible.
    const introText = INTRO_TEXT[slug];
    if (introText) {
      await this.db.insert(messages).values({
        conversationId: id,
        senderType: 'system',
        senderId: 'system',
        contentType: 'text',
        body: { kind: 'text', text: introText },
      });
    }
    this.log.log(`inserted seed conversation ${slug} (${id})`);
  }
}

const INTRO_TEXT: Record<SeedConversationKey, string> = {
  c1: '👋 这是和 DeepSeek **V3** 的单聊。响应快、便宜，适合通用对话和写代码。',
  c2: '🛠️ 这是工程群。`@orchestrator` 一句话需求 → 自动拆 Plan → 多 Agent 并行执行。',
  c3: '🧠 这是和 DeepSeek **R1** 的单聊。会先展示「思考过程」再给答案，适合复杂推理、规划、算法题。',
};
