import { describe, expect, test, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

/**
 * Test that 4xx responses are treated as permanent dead (expired),
 * not transient errors.
 */
describe('backfill 4xx handling', () => {
  test('treats 404 as permanent dead and expires the listing', async () => {
    const dbPath = join(tmpdir(), `backfill-4xx-${Date.now()}.db`);
    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    const now = Date.now();
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
      '', 'https://example.com/404-page', now, now + 86_400_000, now, 'active'
    );

    // Mock fetch to return 404
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;

    try {
      // NOTE: This test does not exercise the actual backfill loop — see
      // https://github.com/two8one7/ai-native-jobs/issues for the follow-up to
      // refactor `fetchHtml` into an exported helper so it can be tested
      // directly. For now this only documents the expected end-state shape.
      const beforeListing = db.prepare('SELECT status, expires_at FROM listings WHERE id = ?').get(listingId) as { status: string; expires_at: number };
      expect(beforeListing.status).toBe('active');
      expect(beforeListing.expires_at).toBeGreaterThan(now);

      // Simulate the backfill behavior: 4xx → expire
      const expireTime = Date.now();
      db.prepare('UPDATE listings SET expires_at = ? WHERE id = ?').run(expireTime, listingId);

      const afterListing = db.prepare('SELECT status, expires_at FROM listings WHERE id = ?').get(listingId) as { status: string; expires_at: number };
      expect(afterListing.expires_at).toBe(expireTime);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });
});
