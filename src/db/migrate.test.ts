import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrate } from './migrate';

/**
 * Create a pre-migration companies DB that looks like a pre-WaaS production DB:
 * ats_provider column exists but the CHECK constraint doesn't include 'waas'.
 * This triggers the rebuildCompaniesTableWithWaaSConstraint path in migrate().
 */
function seedPreWaasDb(dbPath: string, extraCompaniesColumns: string[] = []): void {
  const db = new Database(dbPath);
  const extraCols = extraCompaniesColumns.map(c => `  ${c} TEXT`).join(',\n');
  const extraColsClause = extraCols ? `,\n${extraCols}` : '';
  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      yc_batch TEXT,
      website TEXT,
      logo_url TEXT,
      description TEXT,
      careers_url TEXT,
      ats_provider TEXT CHECK(ats_provider IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'notion', 'custom')),
      careers_probe_at INTEGER,
      careers_probe_result TEXT CHECK(careers_probe_result IN ('found_ats', 'found_custom', 'no_page', 'blocked', 'error')),
      created_at INTEGER NOT NULL${extraColsClause}
    );
    CREATE TABLE listings (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      location_city TEXT,
      location_country TEXT NOT NULL,
      location_is_remote INTEGER NOT NULL,
      location_policy TEXT NOT NULL CHECK(location_policy IN ('remote', 'hybrid', 'onsite')),
      comp_min INTEGER,
      comp_max INTEGER,
      comp_currency TEXT,
      comp_equity INTEGER,
      ai_stack TEXT NOT NULL DEFAULT '[]',
      ai_specialty TEXT CHECK(ai_specialty IN ('nlp', 'vision', 'robotics', 'infra', 'ops')),
      ai_compute_access TEXT,
      description_html TEXT NOT NULL,
      apply_url TEXT NOT NULL,
      posted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'expired', 'filled'))
    );
    CREATE TABLE IF NOT EXISTS paid_listings (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      stripe_session_id TEXT UNIQUE NOT NULL,
      stripe_event_id TEXT UNIQUE NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('founding', 'standard')),
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      customer_email TEXT NOT NULL,
      paid_at INTEGER NOT NULL
    );
  `);
  db.close();
}

describe('migrate — unknown-column guard', () => {
  test('aborts with the unknown column name when companies has an out-of-band column', async () => {
    const dbPath = join(tmpdir(), `anj-25-abort-${Date.now()}.db`);
    seedPreWaasDb(dbPath, ['careers_url_blocked']);

    await expect(migrate(dbPath)).rejects.toThrow('careers_url_blocked');
    await expect(migrate(dbPath)).rejects.toThrow('Migration would drop unknown columns');
  });

  test('succeeds (no throw) when companies has no unknown columns', async () => {
    const dbPath = join(tmpdir(), `anj-25-clean-${Date.now()}.db`);
    seedPreWaasDb(dbPath);

    const result = await migrate(dbPath);
    expect(result).toBe(dbPath);
  });

  test('succeeds on a fresh (empty) DB with no pre-existing tables', async () => {
    const dbPath = join(tmpdir(), `anj-25-fresh-${Date.now()}.db`);
    // No seeding — migrate creates everything from schema.sql; WaaS guard not triggered.
    const result = await migrate(dbPath);
    expect(result).toBe(dbPath);
  });

  test('error message lists all unknown columns', async () => {
    const dbPath = join(tmpdir(), `anj-25-multi-${Date.now()}.db`);
    seedPreWaasDb(dbPath, ['col_alpha', 'col_beta']);

    let threw = false;
    try {
      await migrate(dbPath);
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      expect(msg).toContain('col_alpha');
      expect(msg).toContain('col_beta');
    }
    expect(threw).toBe(true);
  });
});
