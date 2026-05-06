import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { expireListing } from '../bin/backfill-descriptions';
import { normalizeRawJob } from '../scrapers/ats/normalize';
import { upsertListings } from '../scrapers/ats/store';
import type { RawJob } from '../scrapers/ats';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  db.prepare(
    `INSERT INTO companies (id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('company-1', 'acme', 'Acme AI', null, 'https://acme.ai', null, null, null, Date.now());
  return db;
}

function baseRawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    provider: 'custom',
    providerJobId: 'job-001',
    title: 'ML Engineer',
    location: 'Remote',
    description:
      '<p>Build LLM inference systems at scale for production traffic. Design distributed serving infrastructure, optimize GPU utilization, and own reliability for our global inference fleet.</p>',
    applyUrl: 'https://acme.ai/careers/ml-engineer',
    postedAt: null,
    ...overrides,
  };
}

describe('expireListing', () => {
  test('writes a unix-ms epoch when expiring a listing', () => {
    const db = makeDb();
    const listing = normalizeRawJob(baseRawJob(), {
      companyId: 'company-1',
      provider: 'custom',
      providerSlug: 'https://acme.ai/careers',
    });

    upsertListings(db, [listing]);

    const fixedNow = 1_735_123_456_789;
    expireListing(db, listing.id, fixedNow);

    const row = db
      .query('SELECT expires_at FROM listings WHERE id = ?')
      .get(listing.id) as { expires_at: number };

    expect(row.expires_at).toBe(fixedNow);
    expect(row.expires_at).toBeGreaterThanOrEqual(10_000_000_000);

    db.close();
  });
});
