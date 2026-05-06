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

/**
 * Recreates the corruption pattern where renaming companies rewrites listings
 * to reference companies__old, then drops that temp table.
 */
function corruptListingsForeignKey(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  db.exec('ALTER TABLE companies RENAME TO companies__old;');
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
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO companies (
      id, slug, name, yc_batch, website, logo_url, description, careers_url,
      ats_provider, careers_probe_at, careers_probe_result, created_at
    )
    SELECT
      id, slug, name, yc_batch, website, logo_url, description, careers_url,
      ats_provider, careers_probe_at, careers_probe_result, created_at
    FROM companies__old;
  `);
  db.exec('DROP TABLE companies__old;');
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
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

describe('migrate — listings FK repair (#29)', () => {
  test('repairs listings table when FK points to companies__old', async () => {
    const dbPath = join(tmpdir(), `anj-29-repair-${Date.now()}.db`);

    await migrate(dbPath);

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN;');
    db.exec(`
      CREATE TABLE companies__old (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        yc_batch TEXT,
        website TEXT,
        logo_url TEXT,
        description TEXT,
        careers_url TEXT,
        ats_provider TEXT CHECK(ats_provider IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'notion', 'waas', 'custom')),
        careers_probe_at INTEGER,
        careers_probe_result TEXT CHECK(careers_probe_result IN ('found_ats', 'found_custom', 'no_page', 'blocked', 'error')),
        created_at INTEGER NOT NULL
      );
    `);
    db.exec('ALTER TABLE listings RENAME TO listings_orig;');
    db.exec(`
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES "companies__old"(id) ON DELETE CASCADE,
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
    `);
    db.exec('DROP TABLE listings_orig;');
    db.exec('DROP TABLE companies__old;');
    db.exec('COMMIT;');
    db.exec('PRAGMA foreign_keys = ON;');

    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      INSERT INTO companies (id, slug, name, created_at)
      VALUES ('test-co', 'test', 'Test Co', ${Date.now()});
    `);
    db.exec(`
      INSERT INTO listings (
        id, company_id, title, location_country, location_is_remote, location_policy,
        description_html, apply_url, posted_at, expires_at, updated_at, status
      )
      VALUES (
        'test-listing', 'test-co', 'Test Job', 'US', 0, 'onsite',
        '<p>Test</p>', 'https://example.com', ${Date.now()}, ${Date.now() + 86400000}, ${Date.now()}, 'active'
      );
    `);
    db.exec('PRAGMA foreign_keys = ON;');

    const listingCount = (db.query('SELECT COUNT(*) as c FROM listings').get() as { c: number }).c;
    db.close();

    await migrate(dbPath);

    const db2 = new Database(dbPath);
    const listingSql = (
      db2.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='listings'").get() as { sql: string }
    ).sql;
    expect(listingSql).toContain('REFERENCES companies(id)');
    expect(listingSql).not.toContain('companies__old');

    const surviveCount = (db2.query('SELECT COUNT(*) as c FROM listings').get() as { c: number }).c;
    expect(surviveCount).toBe(listingCount);

    const indices = db2.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='listings'",
    ).all() as Array<{ name: string }>;
    const indexNames = indices.map(i => i.name);
    expect(indexNames).toContain('idx_listings_status_expires_at');
    expect(indexNames).toContain('idx_listings_company_id');

    db2.close();
  });

  test('paid_listings inserts succeed after FK repair', async () => {
    const dbPath = join(tmpdir(), `anj-29-paid-insert-${Date.now()}.db`);
    seedPreWaasDb(dbPath);
    corruptListingsForeignKey(dbPath);

    await migrate(dbPath);

    const db = new Database(dbPath);
    const now = Date.now();

    db.exec(`
      INSERT INTO companies (
        id, slug, name, yc_batch, website, logo_url, description, careers_url,
        ats_provider, careers_probe_at, careers_probe_result, created_at
      )
      VALUES (
        'company-after-repair', 'company-after-repair', 'Company After Repair',
        NULL, NULL, NULL, NULL, NULL,
        'custom', NULL, 'found_custom', ${now}
      );
    `);
    db.exec(`
      INSERT INTO listings (
        id, company_id, title, location_city, location_country, location_is_remote,
        location_policy, comp_min, comp_max, comp_currency, comp_equity, ai_stack,
        ai_specialty, ai_compute_access, description_html, apply_url, posted_at,
        expires_at, updated_at, status
      )
      VALUES (
        'listing-after-repair', 'company-after-repair', 'Listing After Repair',
        'Remote', 'US', 1, 'remote', NULL, NULL, NULL, NULL, '[]',
        NULL, NULL, '<p>Test</p>', 'https://example.com',
        ${now}, ${now + 86400000}, ${now}, 'active'
      );
    `);
    db.exec(`
      INSERT INTO paid_listings (
        id, listing_id, stripe_session_id, stripe_event_id, tier, amount_cents,
        currency, customer_email, paid_at
      )
      VALUES (
        'paid-listing-after-repair', 'listing-after-repair', 'sess_after_repair',
        'evt_after_repair', 'standard', 1000, 'usd', 'buyer@example.com', ${now}
      );
    `);

    const row = db.query(
      "SELECT COUNT(*) AS c FROM paid_listings WHERE id = 'paid-listing-after-repair'",
    ).get() as { c: number };
    expect(row.c).toBe(1);
    db.close();
  });

  test('other tables\' FK references stay valid after the rebuild', async () => {
    const dbPath = join(tmpdir(), `anj-29-paid-sql-${Date.now()}.db`);
    seedPreWaasDb(dbPath);
    corruptListingsForeignKey(dbPath);

    await migrate(dbPath);

    const db = new Database(dbPath);
    const paidListingsSql = (
      db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='paid_listings'").get() as { sql: string }
    ).sql;

    expect(paidListingsSql).toMatch(/REFERENCES\s+"?listings"?\s*\(id\)/);
    expect(paidListingsSql).not.toContain('__rebuild');
    expect(paidListingsSql).not.toContain('__old');
    db.close();
  });
});
