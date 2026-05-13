import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://agenthub:agenthub@localhost:5432/agenthub',
  },
  strict: false,
  verbose: true,
} satisfies Config;
