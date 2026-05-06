import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { detectFromText } from '../scrapers/ats/detect';
import { normalizeRawJob } from '../scrapers/ats/normalize';
import { upsertListings } from '../scrapers/ats/store';
import { fetchNotion, parseNextData, parseDomFallback } from '../scrapers/ats/notion';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const fixtureHtml = readFileSync(
  new URL('../scrapers/ats/__fixtures__/notion/example-careers.html', import.meta.url),
  'utf8',
);

function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const g = globalThis as typeof globalThis & { fetch: typeof fetch };
  const orig = g.fetch;
  g.fetch = (async (input, init) => handler(input, init)) as typeof fetch;
  return () => {
    g.fetch = orig;
  };
}

// ─── Detection ────────────────────────────────────────────────────────────────

describe('Notion detection', () => {
  test('detects notion.site subdomain URL', () => {
    expect(
      detectFromText('https://example-corp.notion.site/Careers-Page-ab12cd34ef567890ab12cd34ef567890'),
    ).toEqual({ provider: 'notion', slug: 'Careers-Page-ab12cd34ef567890ab12cd34ef567890' });
  });

  test('detects notion.so workspace/page-id URL (32-char hex)', () => {
    expect(
      detectFromText('https://www.notion.so/example-corp/ab12cd34ef567890ab12cd34ef567890'),
    ).toEqual({ provider: 'notion', slug: 'example-corp:ab12cd34ef567890ab12cd34ef567890' });
  });

  test('detects notion.so workspace/page-id URL (UUID format)', () => {
    expect(
      detectFromText('https://www.notion.so/example-corp/ab12cd34-ef56-7890-ab12-cd34ef567890'),
    ).toEqual({ provider: 'notion', slug: 'example-corp:ab12cd34-ef56-7890-ab12-cd34ef567890' });
  });

  test('detects notion.site from HTML body embed', () => {
    expect(
      detectFromText(
        '<a href="https://example-corp.notion.site/Careers-Page-abc123">Careers</a>',
      ),
    ).toEqual({ provider: 'notion', slug: 'Careers-Page-abc123' });
  });

  test('detects notion.so workspace link from HTML body', () => {
    expect(
      detectFromText(
        '<a href="https://www.notion.so/acme/ab12cd34ef567890ab12cd34ef567890">Jobs</a>',
      ),
    ).toEqual({ provider: 'notion', slug: 'acme:ab12cd34ef567890ab12cd34ef567890' });
  });

  test('returns null for unrelated URL', () => {
    expect(detectFromText('https://boards.greenhouse.io/openai')).not.toEqual({
      provider: 'notion',
      slug: expect.anything(),
    });
  });

  test('returns null for random text', () => {
    expect(detectFromText('https://careers.example.com')).toEqual({ provider: null, slug: null });
  });
});

// ─── Fetcher — __NEXT_DATA__ path ────────────────────────────────────────────

describe('Notion fetcher — __NEXT_DATA__', () => {
  test('extracts jobs from __NEXT_DATA__ in fixture HTML', () => {
    const jobs = parseNextData(fixtureHtml);

    expect(jobs).toHaveLength(3);

    const titles = jobs.map((j) => j.title).sort();
    expect(titles).toEqual([
      'Platform Engineer, AI Infrastructure',
      'Research Scientist, NLP',
      'Senior ML Engineer',
    ]);

    // All jobs tagged as notion provider
    for (const job of jobs) {
      expect(job.provider).toBe('notion');
    }
  });

  test('providerJobId is the 8-char short block ID', () => {
    const jobs = parseNextData(fixtureHtml);
    const ids = jobs.map((j) => j.providerJobId);

    // All IDs must be exactly 8 lowercase hex chars
    for (const id of ids) {
      expect(id).toMatch(/^[a-f0-9]{8}$/);
    }

    // Known IDs from fixture block UUIDs (dashes stripped, first 8 chars)
    expect(ids).toContain('ab12cd34'); // ab12cd34-ef56-7890-ab12-cd34ef567890
    expect(ids).toContain('12ab34cd'); // 12ab34cd-ef56-7890-12ab-34cdef567890
    expect(ids).toContain('ef90ab12'); // ef90ab12-cd34-5678-ef90-ab12cd345678
  });

  test('apply_url is canonical notion.so short URL', () => {
    const jobs = parseNextData(fixtureHtml);
    const mlJob = jobs.find((j) => j.title === 'Senior ML Engineer');

    expect(mlJob?.applyUrl).toBe(
      'https://www.notion.so/ab12cd34ef567890ab12cd34ef567890',
    );
  });

  test('posted_at derived from last_edited_time ISO string', () => {
    const jobs = parseNextData(fixtureHtml);
    const mlJob = jobs.find((j) => j.title === 'Senior ML Engineer');

    // Fixture last_edited_time = 1746057600000
    expect(mlJob?.postedAt).toBe(new Date(1746057600000).toISOString());
  });

  test('posted_at is null when last_edited_time is absent', () => {
    const jobs = parseNextData(fixtureHtml);
    const nlpJob = jobs.find((j) => j.title === 'Research Scientist, NLP');

    expect(nlpJob?.postedAt).toBeNull();
  });

  test('returns empty array for HTML without __NEXT_DATA__', () => {
    const jobs = parseNextData('<html><body>no data here</body></html>');
    expect(jobs).toHaveLength(0);
  });
});

// ─── Fetcher — DOM fallback path ──────────────────────────────────────────────

describe('Notion fetcher — DOM fallback', () => {
  test('extracts jobs from .notion-collection-row elements', () => {
    const jobs = parseDomFallback(fixtureHtml);

    expect(jobs.length).toBeGreaterThanOrEqual(3);

    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Senior ML Engineer');
    expect(titles).toContain('Platform Engineer, AI Infrastructure');
    expect(titles).toContain('Research Scientist, NLP');
  });

  test('posted_at is null for DOM-parsed rows (no timestamp in rendered HTML)', () => {
    const jobs = parseDomFallback(fixtureHtml);
    for (const job of jobs) {
      expect(job.postedAt).toBeNull();
    }
  });
});

// ─── Fetcher — full fetch mock ────────────────────────────────────────────────

describe('Notion fetcher — network path', () => {
  test('fetchNotion returns jobs via mocked HTML response', async () => {
    const restore = installFetchMock(() =>
      new Response(fixtureHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    try {
      const jobs = await fetchNotion('example-corp:Careers-Page-ab12cd34ef567890');
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs[0].provider).toBe('notion');
    } finally {
      restore();
    }
  });

  test('fetchNotion throws on non-200 status', async () => {
    const restore = installFetchMock(
      () => new Response('Not found', { status: 404 }),
    );

    try {
      await expect(
        fetchNotion('example-corp:Careers-Page-abc123'),
      ).rejects.toThrow('Notion fetch failed');
    } finally {
      restore();
    }
  });
});

// ─── Normalization ────────────────────────────────────────────────────────────

describe('Notion normalization', () => {
  const context = {
    companyId: 'company-notion-1',
    provider: 'notion' as const,
    providerSlug: 'example-corp',
  };

  test('posted_at from last_edited_time ISO string', () => {
    const isoDate = '2025-05-01T00:00:00.000Z';
    const listing = normalizeRawJob(
      {
        provider: 'notion',
        providerJobId: 'ab12cd34',
        title: 'Senior ML Engineer',
        location: null,
        description: '',
        applyUrl: 'https://www.notion.so/ab12cd34ef567890ab12cd34ef567890',
        postedAt: isoDate,
      },
      context,
    );

    expect(listing.posted_at).toBe(Date.parse(isoDate));
    expect(listing.id).toBe('notion:example-corp:ab12cd34');
    expect(listing.status).toBe('active');
  });

  test('posted_at falls back to Date.now() when postedAt is null', () => {
    const before = Date.now();
    const listing = normalizeRawJob(
      {
        provider: 'notion',
        providerJobId: 'ef90ab12',
        title: 'Research Scientist, NLP',
        location: null,
        description: '',
        applyUrl: 'https://www.notion.so/ef90ab12cd345678ef90ab12cd345678',
        postedAt: null,
      },
      context,
    );
    const after = Date.now();

    expect(listing.posted_at).toBeGreaterThanOrEqual(before);
    expect(listing.posted_at).toBeLessThanOrEqual(after);
  });
});

// ─── Idempotent upsert ────────────────────────────────────────────────────────

describe('Notion idempotent upsert', () => {
  test('same notion listing inserted twice does not duplicate', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    db.prepare(
      `INSERT INTO companies (
        id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'company-notion-1',
      'example-corp',
      'Example Corp',
      'W25',
      'https://example-corp.com',
      null,
      'AI company',
      'https://example-corp.notion.site/Careers',
      Date.now(),
    );

    const rawJob = {
      provider: 'notion' as const,
      providerJobId: 'ab12cd34',
      title: 'Senior ML Engineer',
      location: null,
      description:
        '<p>Join our team to work on state-of-the-art natural language processing systems. Train, evaluate, and deploy large language models at scale in production serving infrastructure.</p>',
      applyUrl: 'https://www.notion.so/ab12cd34ef567890ab12cd34ef567890',
      postedAt: '2025-05-01T00:00:00.000Z',
    };

    const context = {
      companyId: 'company-notion-1',
      provider: 'notion' as const,
      providerSlug: 'example-corp',
    };

    const listing = normalizeRawJob(rawJob, context);
    upsertListings(db, [listing]);
    upsertListings(db, [listing]); // second insert — must not create duplicate

    const count = db.query('SELECT COUNT(*) as count FROM listings').get() as { count: number };
    const row = db
      .query('SELECT title FROM listings WHERE id = ?')
      .get('notion:example-corp:ab12cd34') as { title: string };

    expect(count.count).toBe(1);
    expect(row.title).toBe('Senior ML Engineer');

    db.close();
  });
});
