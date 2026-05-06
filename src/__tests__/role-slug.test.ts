import { describe, expect, test, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRoleSlug, getIdSuffix } from '../lib/jobs';
import { getListingBySlugs } from '../lib/db';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

// ---------- unit tests -------------------------------------------------------

describe('getIdSuffix', () => {
  test('paid id (no colon) → first 8 chars of full id', () => {
    expect(getIdSuffix('lst_abc12345')).toBe('lst_abc1');
  });

  test('scraped id → first 8 chars of external-id segment', () => {
    expect(getIdSuffix('greenhouse:starcloud:4253303008')).toBe('42533030');
    expect(getIdSuffix('greenhouse:starcloud:4253305008')).toBe('42533050');
  });

  test('two scraped ids with same ATS prefix produce different suffixes', () => {
    const a = getIdSuffix('greenhouse:starcloud:4253303008');
    const b = getIdSuffix('greenhouse:starcloud:4253305008');
    expect(a).not.toBe(b);
  });
});

describe('getRoleSlug', () => {
  test('paid listing slug ends with first 8 chars of id', () => {
    const slug = getRoleSlug({ id: 'lst_abc12345', title: 'Software Engineer' });
    expect(slug.endsWith('-lst_abc1')).toBe(true);
  });

  test('scraped listing uses external-id segment, not ATS prefix', () => {
    const elec = getRoleSlug({ id: 'greenhouse:starcloud:4253303008', title: 'Electrical Engineer' });
    const gnc  = getRoleSlug({ id: 'greenhouse:starcloud:4253305008', title: 'Guidance, Navigation & Control (GNC) Engineer' });
    expect(elec.endsWith('-42533030')).toBe(true);
    expect(gnc.endsWith('-42533050')).toBe(true);
    expect(elec).not.toBe(gnc);
  });
});

// ---------- round-trip tests --------------------------------------------------

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** Temp DB paths to clean up after tests. */
const tempDbs: string[] = [];

/** Original env value so we can restore it. */
const origDbPath = process.env.AINATIVE_DB_PATH;

afterAll(() => {
  if (origDbPath === undefined) {
    delete process.env.AINATIVE_DB_PATH;
  } else {
    process.env.AINATIVE_DB_PATH = origDbPath;
  }
  for (const p of tempDbs) {
    try { unlinkSync(p); } catch { /* best effort */ }
  }
});

function makeTempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `role-slug-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempDbs.push(path);
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return { db, path };
}

function insertCompany(db: Database, id: string, slug: string, name: string): void {
  db.prepare(
    `INSERT INTO companies (id, slug, name, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, slug, name, NOW);
}

function insertListing(db: Database, id: string, companyId: string, title: string): void {
  db.prepare(`
    INSERT INTO listings (
      id, company_id, title,
      location_country, location_is_remote, location_policy,
      description_html, apply_url,
      posted_at, expires_at, updated_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, companyId, title,
    'US', 0, 'onsite',
    '<p>AI job.</p>', 'https://apply.example.com/job',
    NOW, FAR_FUTURE, NOW, 'active',
  );
}

describe('getListingBySlugs — ATS prefix collision', () => {
  test('returns correct listing for each of two scraped ids sharing ATS prefix', async () => {
    const { db, path } = makeTempDb();
    insertCompany(db, 'co-1', 'starcloud', 'Starcloud');
    insertListing(db, 'greenhouse:starcloud:4253303008', 'co-1', 'Electrical Engineer');
    insertListing(db, 'greenhouse:starcloud:4253305008', 'co-1', 'Guidance, Navigation & Control (GNC) Engineer');
    db.close();

    process.env.AINATIVE_DB_PATH = path;

    const slug1 = getRoleSlug({ id: 'greenhouse:starcloud:4253303008', title: 'Electrical Engineer' });
    const slug2 = getRoleSlug({ id: 'greenhouse:starcloud:4253305008', title: 'Guidance, Navigation & Control (GNC) Engineer' });
    expect(slug1).not.toBe(slug2);

    const result1 = await getListingBySlugs('starcloud', slug1);
    const result2 = await getListingBySlugs('starcloud', slug2);

    expect(result1?.id).toBe('greenhouse:starcloud:4253303008');
    expect(result2?.id).toBe('greenhouse:starcloud:4253305008');
  });
});

describe('getListingBySlugs — same title, different ids (collision scenario)', () => {
  test('slugs differ and each slug resolves to the correct listing', async () => {
    const { db, path } = makeTempDb();
    insertCompany(db, 'co-2', 'acme', 'Acme');
    // Same title, different external-id segments → different suffixes → different slugs
    insertListing(db, 'greenhouse:acme:11112222', 'co-2', 'Software Engineer');
    insertListing(db, 'greenhouse:acme:99998888', 'co-2', 'Software Engineer');
    db.close();

    process.env.AINATIVE_DB_PATH = path;

    const slugA = getRoleSlug({ id: 'greenhouse:acme:11112222', title: 'Software Engineer' });
    const slugB = getRoleSlug({ id: 'greenhouse:acme:99998888', title: 'Software Engineer' });
    expect(slugA).not.toBe(slugB);

    const resultA = await getListingBySlugs('acme', slugA);
    const resultB = await getListingBySlugs('acme', slugB);

    expect(resultA?.id).toBe('greenhouse:acme:11112222');
    expect(resultB?.id).toBe('greenhouse:acme:99998888');
  });
});

describe('getListingBySlugs — paid listing shape unchanged', () => {
  test('paid id slug resolves correctly', async () => {
    const { db, path } = makeTempDb();
    insertCompany(db, 'co-3', 'techcorp', 'TechCorp');
    insertListing(db, 'lst_abc12345', 'co-3', 'Backend Engineer');
    db.close();

    process.env.AINATIVE_DB_PATH = path;

    const slug = getRoleSlug({ id: 'lst_abc12345', title: 'Backend Engineer' });
    expect(slug.endsWith('-lst_abc1')).toBe(true);

    const result = await getListingBySlugs('techcorp', slug);
    expect(result?.id).toBe('lst_abc12345');
  });
});
