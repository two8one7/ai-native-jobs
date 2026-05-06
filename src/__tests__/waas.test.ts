import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Company } from '../db/types';
import { scrapeCompanyListings } from '../scrapers/ats';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const fixture = readFileSync(
  new URL('../scrapers/ats/__fixtures__/waas/corgi-embed.html', import.meta.url),
  'utf8',
);

describe('waas scrape integration', () => {
  test('stores workatastartup.com apply urls and clears the dead-url repro query', async () => {
    const db = new Database(':memory:');
    const realFetch = globalThis.fetch;
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    db.prepare(
      `INSERT INTO companies (
        id, slug, name, yc_batch, website, logo_url, description, careers_url,
        ats_provider, careers_probe_at, careers_probe_result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'company-1',
      'corgi-insurance',
      'Corgi Insurance',
      'S24',
      'https://example.com',
      null,
      null,
      'https://www.workatastartup.com/companies/corgi-insurance',
      'waas',
      null,
      'found_ats',
      Date.now(),
    );

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://www.workatastartup.com/companies/corgi-insurance/jobs.json') {
        return new Response('not found', { status: 404 });
      }

      if (url === 'https://example.com/' || url === 'https://example.com/careers') {
        return new Response(fixture, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const company = db.query('SELECT * FROM companies WHERE id = ?').get('company-1') as Company;
      const result = await scrapeCompanyListings(db, company);
      expect(result.provider).toBe('waas');
      expect(result.listings).toBe(1);

      const badUrlCount = db
        .query(
          `SELECT COUNT(*) AS count
           FROM listings
           WHERE status = 'active'
             AND apply_url LIKE '%/companies/%/jobs/%'
             AND apply_url NOT LIKE '%workatastartup.com%'`,
        )
        .get() as { count: number };

      const row = db.query('SELECT apply_url FROM listings LIMIT 1').get() as { apply_url: string };
      expect(badUrlCount.count).toBe(0);
      expect(row.apply_url).toBe(
        'https://www.workatastartup.com/companies/corgi-insurance/jobs/bJnshAq-full-stack-software-engineer',
      );
    } finally {
      globalThis.fetch = realFetch;
      db.close();
    }
  });
});
