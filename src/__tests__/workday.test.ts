import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { detectFromText } from '../scrapers/ats/detect';
import { normalizeRawJob } from '../scrapers/ats/normalize';
import { upsertListings } from '../scrapers/ats/store';
import { fetchWorkday, parseWorkdayPostedOn } from '../scrapers/ats/workday';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const DAY_MS = 24 * 60 * 60 * 1000;

type WorkdaySeed = {
  title: string;
  externalPath: string;
  locationsText: string;
  postedOn: string;
  jobPostingId: string;
  description: string;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
    },
  });
}

function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const globalFetch = globalThis as typeof globalThis & { fetch: typeof fetch };
  const originalFetch = globalFetch.fetch;
  globalFetch.fetch = (async (input, init) => handler(input, init)) as typeof fetch;
  return () => {
    globalFetch.fetch = originalFetch;
  };
}

function makeSeed(index: number): WorkdaySeed {
  const jobPostingId = `wd-${index}`;
  return {
    title: `Inference Engineer ${index}`,
    externalPath: `/job/san-francisco-ca/Inference-Engineer-${index}_${jobPostingId}`,
    locationsText: 'San Francisco, CA',
    postedOn: index % 2 === 0 ? 'Posted Yesterday' : 'Posted 2 Days Ago',
    jobPostingId,
    description: `<p>Build Workday-backed inference systems ${index}. Design distributed inference pipelines, optimize GPU utilization, and maintain sub-100ms p99 latency at scale across our production fleet.</p>`,
  };
}

function createWorkdayHandler(seeds: WorkdaySeed[]) {
  const seedByPath = new Map(seeds.map((seed) => [seed.externalPath, seed] as const));
  const listOffsets: number[] = [];

  return {
    listOffsets,
    handler(input: RequestInfo | URL, init?: RequestInit): Response {
      const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;

      if (pathname.endsWith('/jobs')) {
        if (init?.method !== 'POST') {
          throw new Error(`unexpected Workday list method: ${init?.method ?? 'undefined'}`);
        }

        const payload = JSON.parse(String(init.body ?? '{}')) as { offset?: number };
        const offset = payload.offset ?? 0;
        listOffsets.push(offset);

        const page = seeds.slice(offset, offset + 20);
        return jsonResponse({
          total: seeds.length,
          jobPostings: page.map((seed) => ({
            title: seed.title,
            externalPath: seed.externalPath,
            locationsText: seed.locationsText,
            postedOn: seed.postedOn,
            bulletFields: [seed.jobPostingId],
          })),
        });
      }

      const externalPath = pathname.slice(pathname.indexOf('/job/'));
      const seed = seedByPath.get(externalPath);
      if (!seed) {
        throw new Error(`unexpected Workday detail path: ${pathname}`);
      }

      return jsonResponse({
        jobPostingInfo: {
          jobPostingId: seed.jobPostingId,
          jobDescription: seed.description,
          location: {
            locationsText: seed.locationsText,
          },
          postedOn: seed.postedOn,
        },
      });
    },
  };
}

describe('Workday scraper', () => {
  test('detects workday URLs and body links', () => {
    expect(
      detectFromText('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/jobs/123'),
    ).toEqual({
      provider: 'workday',
      slug: 'nvidia:wd5:NVIDIAExternalCareerSite',
    });

    expect(
      detectFromText('<a href="https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite">Jobs</a>'),
    ).toEqual({
      provider: 'workday',
      slug: 'nvidia:wd5:NVIDIAExternalCareerSite',
    });
  });

  test('paginates, fetches details, and attaches descriptions', async () => {
    const seeds = Array.from({ length: 21 }, (_, index) => makeSeed(index + 1));
    const mock = createWorkdayHandler(seeds);
    const restoreFetch = installFetchMock(mock.handler);

    try {
      const jobs = await fetchWorkday('nvidia:wd5:NVIDIAExternalCareerSite');

      expect(mock.listOffsets).toEqual([0, 20]);
      expect(jobs).toHaveLength(21);
      expect(jobs[0].providerJobId).toBe('wd-1');
      expect(jobs[0].description).toContain('Build Workday-backed inference systems 1.');
      expect(jobs[20].description).toContain('Build Workday-backed inference systems 21.');
      expect(jobs[0].postedAt).toBeTruthy();
    } finally {
      restoreFetch();
    }
  });

  test('upserts idempotently across re-runs', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    db.prepare(
      `INSERT INTO companies (
        id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'company-1',
      'nvidia',
      'NVIDIA',
      'W24',
      'https://nvidia.com',
      null,
      'GPU company',
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
      Date.now(),
    );

    const seeds = [makeSeed(1), makeSeed(2)];
    const mock = createWorkdayHandler(seeds);
    const restoreFetch = installFetchMock(mock.handler);

    try {
      const rawJobs = await fetchWorkday('nvidia:wd5:NVIDIAExternalCareerSite');
      const listings = rawJobs.map((rawJob) =>
        normalizeRawJob(rawJob, {
          companyId: 'company-1',
          provider: 'workday',
          providerSlug: 'nvidia:wd5:NVIDIAExternalCareerSite',
        }),
      );

      upsertListings(db, listings);
      upsertListings(db, listings);

      const count = db.query('SELECT COUNT(*) as count FROM listings').get() as { count: number };
      const row = db
        .query('SELECT title FROM listings WHERE id = ?')
        .get('workday:nvidia:wd5:NVIDIAExternalCareerSite:wd-1') as { title: string };

      expect(count.count).toBe(2);
      expect(row.title).toBe('Inference Engineer 1');
    } finally {
      restoreFetch();
      db.close();
    }
  });

  test('parses posted-on phrases into ISO timestamps', () => {
    const originalNow = Date.now;
    const fixedNow = Date.UTC(2026, 3, 10, 12, 0, 0);
    Date.now = () => fixedNow;

    try {
      expect(parseWorkdayPostedOn('Posted Yesterday')).toBe(
        new Date(fixedNow - DAY_MS).toISOString(),
      );
      expect(parseWorkdayPostedOn('Posted 2 Days Ago')).toBe(
        new Date(fixedNow - 2 * DAY_MS).toISOString(),
      );
      expect(parseWorkdayPostedOn('Posted 30+ Days Ago')).toBe(
        new Date(fixedNow - 30 * DAY_MS).toISOString(),
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
