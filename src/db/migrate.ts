import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDbWrite } from '../lib/db-write';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);
const ATS_PROVIDER_CHECK_SQL =
  "CHECK(ats_provider IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'notion', 'waas', 'custom'))";

// Canonical column set for the companies table rebuild. Any live column NOT in
// this set will cause the migration to abort — ops must drop the column or add
// it to the canonical schema before retrying.
const COMPANIES_CANONICAL_COLUMNS = new Set([
  'id', 'slug', 'name', 'yc_batch', 'website', 'logo_url', 'description',
  'careers_url', 'ats_provider', 'careers_probe_at', 'careers_probe_result', 'created_at',
]);

// Canonical column set for the listings table rebuild.
const LISTINGS_CANONICAL_COLUMNS = new Set([
  'id', 'company_id', 'title', 'location_city', 'location_country', 'location_is_remote',
  'location_policy', 'comp_min', 'comp_max', 'comp_currency', 'comp_equity', 'ai_stack',
  'ai_specialty', 'ai_compute_access', 'description_html', 'apply_url', 'posted_at',
  'expires_at', 'updated_at', 'status',
]);

/**
 * Throws if the live table has any column not in `canonicalColumns`. Use before
 * any table-rebuild that re-creates the table with a fixed INSERT-SELECT column
 * list, so out-of-band columns are never silently dropped.
 */
function assertNoUnknownColumns(
  db: Database,
  tableName: string,
  canonicalColumns: Set<string>,
): void {
  const tableInfo = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const unknown = tableInfo.map(r => r.name).filter(n => !canonicalColumns.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `Migration would drop unknown columns: [${unknown.join(', ')}]; aborting. Investigate before retrying.`,
    );
  }
}

function companiesTableSupportsWaaS(db: Database): boolean {
  const row = db
    .query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'companies'",
    )
    .get() as { sql: string | null } | null;

  return row?.sql?.includes("'waas'") ?? false;
}

function listingsFkPointsAtCompaniesOld(db: Database): boolean {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'listings'")
    .get() as { sql: string | null } | null;

  return row?.sql?.includes('companies__old') ?? false;
}

function rebuildCompaniesTableWithWaaSConstraint(db: Database): void {
  assertNoUnknownColumns(db, 'companies', COMPANIES_CANONICAL_COLUMNS);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('PRAGMA legacy_alter_table = ON;');

  try {
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
        ats_provider TEXT ${ATS_PROVIDER_CHECK_SQL},
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF;');
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function rebuildListingsForeignKey(db: Database): void {
  assertNoUnknownColumns(db, 'listings', LISTINGS_CANONICAL_COLUMNS);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('PRAGMA legacy_alter_table = ON;');

  try {
    db.exec('BEGIN;');
    db.exec('ALTER TABLE listings RENAME TO listings__rebuild;');
    db.exec(`
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
    `);
    db.exec(`
      INSERT INTO listings (
        id, company_id, title, location_city, location_country, location_is_remote,
        location_policy, comp_min, comp_max, comp_currency, comp_equity, ai_stack,
        ai_specialty, ai_compute_access, description_html, apply_url, posted_at,
        expires_at, updated_at, status
      )
      SELECT
        id, company_id, title, location_city, location_country, location_is_remote,
        location_policy, comp_min, comp_max, comp_currency, comp_equity, ai_stack,
        ai_specialty, ai_compute_access, description_html, apply_url, posted_at,
        expires_at, updated_at, status
      FROM listings__rebuild;
    `);
    db.exec('DROP TABLE listings__rebuild;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listings_status_expires_at ON listings(status, expires_at);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listings_company_id ON listings(company_id);');

    const fkErrors = db.query('PRAGMA foreign_key_check;').all() as Array<Record<string, unknown>>;
    if (fkErrors.length > 0) {
      throw new Error(`Foreign key check failed: ${JSON.stringify(fkErrors)}`);
    }

    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF;');
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function findStaleTempTableReferences(db: Database): Array<{ table: string; missingRef: string }> {
  const liveTables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(row => row.name),
  );
  const tableRows = db.query(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL",
  ).all() as Array<{ name: string; sql: string }>;
  const staleRefs = new Map<string, { table: string; missingRef: string }>();
  const referencePattern = /REFERENCES\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;

  for (let i = 0; i < tableRows.length; i += 1) {
    const row = tableRows[i];
    referencePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = referencePattern.exec(row.sql)) !== null) {
      const missingRef = match[1] ?? match[2];
      if (!missingRef) {
        continue;
      }

      if (liveTables.has(missingRef)) {
        continue;
      }

      if (
        !missingRef.includes('__old') &&
        !missingRef.includes('__rebuild') &&
        !missingRef.includes('_old') &&
        !missingRef.includes('_new')
      ) {
        continue;
      }

      const key = `${row.name}::${missingRef}`;
      if (!staleRefs.has(key)) {
        staleRefs.set(key, { table: row.name, missingRef });
      }
    }
  }

  return Array.from(staleRefs.values());
}

function assertNoStaleTempTableReferences(db: Database): void {
  const staleRefs = findStaleTempTableReferences(db);
  if (staleRefs.length > 0) {
    throw new Error(
      `Stale temp-table references found: ${staleRefs
        .map(({ table, missingRef }) => `${table} -> ${missingRef}`)
        .join(', ')}`,
    );
  }
}

export async function migrate(dbPath = process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH): Promise<string> {
  const absoluteDbPath = resolve(dbPath);
  mkdirSync(dirname(absoluteDbPath), { recursive: true });

  return await runMigration(absoluteDbPath);
}

async function runMigration(absoluteDbPath: string): Promise<string> {
  const db = await openDbWrite(absoluteDbPath);
  try {
    // First, create tables from schema
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    
    // Then run migrations
    const tableInfo = db.query('PRAGMA table_info(companies)').all() as Array<{ name: string }>;
    const hasCareersUrl = tableInfo.some(col => col.name === 'careers_url');
    if (!hasCareersUrl) {
      db.exec('ALTER TABLE companies ADD COLUMN careers_url TEXT');
    }

    const hasAtsProvider = tableInfo.some(col => col.name === 'ats_provider');
    if (!hasAtsProvider) {
      db.exec(
        `ALTER TABLE companies ADD COLUMN ats_provider TEXT ${ATS_PROVIDER_CHECK_SQL}`,
      );
    }

    const hasCareersProbeAt = tableInfo.some(col => col.name === 'careers_probe_at');
    if (!hasCareersProbeAt) {
      db.exec('ALTER TABLE companies ADD COLUMN careers_probe_at INTEGER');
    }

    const hasCareersProbeResult = tableInfo.some(col => col.name === 'careers_probe_result');
    if (!hasCareersProbeResult) {
      db.exec(
        "ALTER TABLE companies ADD COLUMN careers_probe_result TEXT CHECK(careers_probe_result IN ('found_ats', 'found_custom', 'no_page', 'blocked', 'error'))",
      );
    }

    const listingInfo = db.query('PRAGMA table_info(listings)').all() as Array<{ name: string }>;
    const hasUpdatedAt = listingInfo.some(col => col.name === 'updated_at');
    if (!hasUpdatedAt) {
      db.exec('ALTER TABLE listings ADD COLUMN updated_at INTEGER');
      db.exec('UPDATE listings SET updated_at = posted_at WHERE updated_at IS NULL');
    }

    if (hasAtsProvider && !companiesTableSupportsWaaS(db)) {
      rebuildCompaniesTableWithWaaSConstraint(db);
    }

    if (listingsFkPointsAtCompaniesOld(db)) {
      rebuildListingsForeignKey(db);
    }

    assertNoStaleTempTableReferences(db);
  } finally {
    db.close();
  }

  return absoluteDbPath;
}

if (import.meta.main) {
  migrate().then((dbPath) => {
    console.log(`migrated ${dbPath}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
