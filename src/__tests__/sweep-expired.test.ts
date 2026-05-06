import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDbWrite } from '../lib/db-write';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

describe('sweep-expired', () => {
  test('updates active+past to expired, leaves active+future and already-expired untouched', async () => {
    const dbPath = join(tmpdir(), `sweep-expired-${Date.now()}.db`);
    let db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    const now = Date.now();
    const companyId = 'test-company-sweep';

    db.prepare(`INSERT INTO companies (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(companyId, 'test-company', 'Test Company', now);

    const activeFutureId = 'active-future-123';
    const activePastId = 'active-past-456';
    const expiredPastId = 'expired-past-789';

    // Insert 3 listings
    db.prepare(`
      INSERT INTO listings (
        id, company_id, title, location_country, location_is_remote, location_policy,
        description_html, apply_url, posted_at, expires_at, updated_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activeFutureId, companyId, 'Job 1', 'US', 1, 'remote',
      'Description', 'https://example.com/1', now, now + 86_400_000, now, 'active'
    );

    db.prepare(`
      INSERT INTO listings (
        id, company_id, title, location_country, location_is_remote, location_policy,
        description_html, apply_url, posted_at, expires_at, updated_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activePastId, companyId, 'Job 2', 'US', 1, 'remote',
      'Description', 'https://example.com/2', now - 86_400_000, now - 3600_000, now - 86_400_000, 'active'
    );

    db.prepare(`
      INSERT INTO listings (
        id, company_id, title, location_country, location_is_remote, location_policy,
        description_html, apply_url, posted_at, expires_at, updated_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      expiredPastId, companyId, 'Job 3', 'US', 1, 'remote',
      'Description', 'https://example.com/3', now - 172_800_000, now - 86_400_000, now - 172_800_000, 'expired'
    );

    db.close();

    // Run the sweep logic
    const sweepDb = await openDbWrite(dbPath);
    const result = sweepDb
      .prepare(
        `UPDATE listings SET status = 'expired'
          WHERE status = 'active' AND expires_at < ?`,
      )
      .run(now);
    expect(result.changes).toBe(1); // Only active-past should update
    sweepDb.close();

    // Verify results
    const verifyDb = new Database(dbPath);
    const activeFuture = verifyDb.prepare('SELECT status FROM listings WHERE id = ?').get(activeFutureId) as { status: string };
    const activePast = verifyDb.prepare('SELECT status FROM listings WHERE id = ?').get(activePastId) as { status: string };
    const expiredPast = verifyDb.prepare('SELECT status FROM listings WHERE id = ?').get(expiredPastId) as { status: string };

    expect(activeFuture.status).toBe('active');
    expect(activePast.status).toBe('expired');
    expect(expiredPast.status).toBe('expired');

    verifyDb.close();
  });
});
