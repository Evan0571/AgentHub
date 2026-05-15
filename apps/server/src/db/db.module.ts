import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { createDb, type Db } from '@agenthub/db';
import { DB_TOKEN } from './constants.js';
import { MessagesRepo } from './messages.repo.js';
import { PlansRepo } from './plans.repo.js';
import { ConversationsRepo } from './conversations.repo.js';
import { AgentsRepo } from './agents.repo.js';

// Re-export constants so existing call-sites importing from db.module keep working.
export { DB_TOKEN, DEMO_USER_ID, DEMO_USER_EMAIL } from './constants.js';

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): Db => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL not set');
        return createDb(url);
      },
    },
    MessagesRepo,
    PlansRepo,
    ConversationsRepo,
    AgentsRepo,
  ],
  exports: [DB_TOKEN, MessagesRepo, PlansRepo, ConversationsRepo, AgentsRepo],
})
export class DbModule implements OnModuleInit {
  private readonly log = new Logger('DbModule');
  onModuleInit() {
    this.log.log('Drizzle DB connection ready');
  }
}
