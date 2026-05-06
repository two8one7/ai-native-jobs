import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);
const ATS_PROVIDER_CHECK_SQL =
  "CHECK(ats_provider IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'notion', 'waas', 'custom'))";

function companiesTableSupportsWaaS(db: Database): boolean {
  const row = db
    .query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'companies'",
    )
    .get() as { sql: string | null } | null;

  return row?.sql?.includes("'waas'") ?? false;
}

function rebuildCompaniesTableWithWaaSConstraint(db: Database): void {
  db.exec('PRAGMA foreign_keys = OFF;');

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
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

export function migrate(dbPath = process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH): string {
  const absoluteDbPath = resolve(dbPath);
  mkdirSync(dirname(absoluteDbPath), { recursive: true });

  const db = new Database(absoluteDbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    
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
  } finally {
    db.close();
  }

  return absoluteDbPath;
}

if (import.meta.main) {
  const dbPath = migrate();
  console.log(`migrated ${dbPath}`);
}
