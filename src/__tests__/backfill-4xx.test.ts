import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { processRow } from '../bin/backfill-descriptions';
import type { FetchImpl } from '../bin/backfill-descriptions';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function makeTestDb(): Database {
  const dbPath = join(tmpdir(), `backfill-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return db;
}

function insertListing(db: Database, now: number): { listingId: string } {
  const companyId = 'test-company-123';
  const listingId = 'test-listing-456';

  db.prepare(`INSERT INTO companies (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
    .run(companyId, 'test-company', 'Test Company', now);

  db.prepare(`
    INSERT INTO listings (
      id, company_id, title, location_country, location_is_remote, location_policy,
      description_html, apply_url, posted_at, expires_at, updated_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    listingId, companyId, 'Test Job', 'US', 1, 'remote',
    '', 'https://example.com/job', now, now + 86_400_000, now, 'active',
  );

  return { listingId };
}

describe('backfill processRow', () => {
  test('treats 404 as permanently dead and expires the listing', async () => {
    const db = makeTestDb();
    const now = Date.now();
    const { listingId } = insertListing(db, now);

    const fakeFetch: FetchImpl = async (_url) => ({
      html: null,
      permanentlyDead: true,
      status: 404,
    });

    const listing = { id: listingId, title: 'Test Job', apply_url: 'https://example.com/job', company_id: 'test-company-123' };
    const outcome = await processRow(db, listing, fakeFetch, now);

    expect(outcome).toBe('expired');

    const row = db.prepare('SELECT expires_at FROM listings WHERE id = ?').get(listingId) as { expires_at: number };
    expect(row.expires_at).toBeLessThanOrEqual(now);

    db.close();
  });

  test('fills description when fetch returns sufficient HTML content', async () => {
    const db = makeTestDb();
    const now = Date.now();
    const { listingId } = insertListing(db, now);

    // Repeat enough text so stripped content is >= 200 chars.
    const longText = 'Senior engineer role requiring strong TypeScript, distributed systems, and AI/ML experience. '.repeat(4);
    const richHtml = `<html><body><main><p>${longText}</p></main></body></html>`;

    const fakeFetch: FetchImpl = async (_url) => ({
      html: richHtml,
      permanentlyDead: false,
    });

    const listing = { id: listingId, title: 'Test Job', apply_url: 'https://example.com/job', company_id: 'test-company-123' };
    const outcome = await processRow(db, listing, fakeFetch, now);

    expect(outcome).toBe('filled');

    const row = db.prepare('SELECT description_html FROM listings WHERE id = ?').get(listingId) as { description_html: string };
    expect(row.description_html.length).toBeGreaterThan(0);

    db.close();
  });

  test('expires listing when HTML body has fewer than 200 chars of text', async () => {
    const db = makeTestDb();
    const now = Date.now();
    const { listingId } = insertListing(db, now);

    const shortHtml = `<html><body><main><p>Short job description.</p></main></body></html>`;

    const fakeFetch: FetchImpl = async (_url) => ({
      html: shortHtml,
      permanentlyDead: false,
    });

    const listing = { id: listingId, title: 'Test Job', apply_url: 'https://example.com/job', company_id: 'test-company-123' };
    const outcome = await processRow(db, listing, fakeFetch, now);

    expect(outcome).toBe('expired');

    const row = db.prepare('SELECT expires_at FROM listings WHERE id = ?').get(listingId) as { expires_at: number };
    expect(row.expires_at).toBeLessThanOrEqual(now);

    db.close();
  });
});
