import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { users, type Db } from '@agenthub/db';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, DEMO_USER_ID, DEMO_USER_EMAIL } from './constants.js';
import { AgentsRepo } from './agents.repo.js';

/** Built-in agents — public, owner-less, can be invited to any conversation. */
const BUILT_IN_AGENTS = [
  {
    id: 'deepseek-v3',
    name: 'DeepSeek V3',
    adapterId: 'deepseek-v3',
    avatarColor: '#4f46e5',
    systemPrompt: '',
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    adapterId: 'deepseek-r1',
    avatarColor: '#7c3aed',
    systemPrompt: '',
  },
  {
    id: 'codex',
    name: 'Codex (GPT-4o)',
    adapterId: 'codex',
    avatarColor: '#10b981',
    systemPrompt: '',
  },
  {
    id: 'mock',
    name: 'Mock',
    adapterId: 'mock',
    avatarColor: '#6b7280',
    systemPrompt: '',
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    adapterId: 'orchestrator', // pseudo — handled specially by MentionRouter
    avatarColor: '#f97316',
    systemPrompt: '',
  },
];

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly log = new Logger('SeedService');

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly agentsRepo: AgentsRepo,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureDemoUser();
    for (const a of BUILT_IN_AGENTS) {
      await this.agentsRepo.ensureBuiltIn(a);
    }
    this.log.log('seed complete (built-in agents only — user creates own conversations)');
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
}
