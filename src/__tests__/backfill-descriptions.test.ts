import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { extractMainContent } from '../bin/backfill-descriptions';
import { normalizeRawJob } from '../scrapers/ats/normalize';
import { upsertListings } from '../scrapers/ats/store';
import type { RawJob } from '../scrapers/ats';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

// ── extractMainContent heuristic ────────────────────────────────────────────

describe('extractMainContent', () => {
  test('prefers <article> when present', () => {
    const html = `
      <html><body>
        <nav>Nav stuff</nav>
        <article>
          <h1>Senior ML Engineer</h1>
          <p>Build production PyTorch systems at scale.</p>
        </article>
        <footer>Footer</footer>
      </body></html>`;

    const result = extractMainContent(html);
    expect(result).toContain('Senior ML Engineer');
    expect(result).toContain('Build production PyTorch systems');
    expect(result).not.toContain('Nav stuff');
    expect(result).not.toContain('Footer');
  });

  test('falls back to <main> when no <article>', () => {
    const html = `
      <html><body>
        <header>Site header</header>
        <main>
          <h1>Staff Research Scientist</h1>
          <p>Join our NLP team and advance language model research.</p>
        </main>
        <aside>Sidebar</aside>
      </body></html>`;

    const result = extractMainContent(html);
    expect(result).toContain('Staff Research Scientist');
    expect(result).toContain('NLP team');
    expect(result).not.toContain('Sidebar');
  });

  test('falls back to h1 + siblings when no <article> or <main>', () => {
    const html = `
      <html><body>
        <div class="hero">
          <h1>Infrastructure Engineer</h1>
          <p>Own our GPU training cluster and inference serving stack.</p>
          <ul><li>Design distributed systems</li><li>CUDA optimization</li></ul>
        </div>
      </body></html>`;

    const result = extractMainContent(html);
    expect(result).toContain('Infrastructure Engineer');
    expect(result).toContain('GPU training cluster');
    expect(result).toContain('CUDA optimization');
  });

  test('falls back to <body> when h1 has no same-parent siblings', () => {
    const html = `
      <html><body>
        <header><h1>Isolated Heading</h1></header>
        <section>
          <p>The actual job description content lives here.</p>
        </section>
      </body></html>`;

    const result = extractMainContent(html);
    // h1 sibling heuristic yields only h1 itself, so we fall through to body
    expect(result).toContain('The actual job description content');
  });

  test('returns body innerHTML for effectively empty page', () => {
    const html = '<html><head><title>Loading…</title></head><body></body></html>';
    const result = extractMainContent(html);
    // Empty body — result should be empty or whitespace only
    expect(result.trim()).toBe('');
  });
});

// ── empty-body guard in upsertListings ──────────────────────────────────────

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

const context = {
  companyId: 'company-1',
  provider: 'custom' as const,
  providerSlug: 'https://acme.ai/careers',
};

describe('upsertListings empty-body guard', () => {
  test('inserts listing with sufficient description', () => {
    const db = makeDb();
    const listing = normalizeRawJob(baseRawJob(), context);
    upsertListings(db, [listing]);

    const count = db.query('SELECT COUNT(*) as n FROM listings').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  test('skips listing with description under 100 stripped chars', () => {
    const db = makeDb();
    const listing = normalizeRawJob(
      baseRawJob({ description: '<p>Too short.</p>' }),
      context,
    );
    upsertListings(db, [listing]);

    const count = db.query('SELECT COUNT(*) as n FROM listings').get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  test('skips listing with empty description', () => {
    const db = makeDb();
    const listing = normalizeRawJob(baseRawJob({ description: '' }), context);
    upsertListings(db, [listing]);

    const count = db.query('SELECT COUNT(*) as n FROM listings').get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  test('inserts valid listings in the same batch even when some are skipped', () => {
    const db = makeDb();

    const good = normalizeRawJob(baseRawJob({ providerJobId: 'job-good' }), context);
    const bad = normalizeRawJob(
      baseRawJob({ providerJobId: 'job-bad', description: '' }),
      context,
    );

    upsertListings(db, [good, bad]);

    const count = db.query('SELECT COUNT(*) as n FROM listings').get() as { n: number };
    expect(count.n).toBe(1);

    const row = db
      .query('SELECT id FROM listings')
      .get() as { id: string };
    expect(row.id).toContain('job-good');
    db.close();
  });
});
