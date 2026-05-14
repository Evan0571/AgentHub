/**
 * Constants shared between db.module / seed.service / repos.
 * Lives in its own file to avoid circular imports.
 */

export const DB_TOKEN = 'DRIZZLE_DB';

/** Demo single-user setup — no auth yet. Fixed UUID so seed is idempotent. */
export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_USER_EMAIL = 'demo@agenthub.local';

/** Stable UUIDs for seed conversations. Client uses slugs (c1/c2/c3); we
 * map them to these UUIDs at the persistence boundary. */
export const SLUG_TO_UUID: Record<string, string> = {
  c1: '11111111-1111-4111-8111-111111111111',
  c2: '22222222-2222-4222-8222-222222222222',
  c3: '33333333-3333-4333-8333-333333333333',
};

export const UUID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_UUID).map(([s, u]) => [u, s]),
);
