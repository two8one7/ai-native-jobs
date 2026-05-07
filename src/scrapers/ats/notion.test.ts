import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { detectFromText } from './detect';
import {
  buildUrl,
  extractJobsFromRecordMap,
  extractPageIdFromHtml,
  extractPageIdFromSlug,
  fetchNotion,
  findCollectionViews,
  normalizePageId,
  unwrapBlockValue,
} from './notion';

const FIXTURE_BASE = new URL('./__fixtures__/notion/', import.meta.url);

function loadText(name: string): string {
  return readFileSync(new URL(name, FIXTURE_BASE), 'utf8');
}

function loadJson<T = unknown>(name: string): T {
  return JSON.parse(loadText(name)) as T;
}

type RecordMapWrapper = { recordMap?: { block?: Record<string, unknown> } };

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('normalizePageId', () => {
  test('passes through dashed UUID', () => {
    expect(normalizePageId('2176507c-3e3a-80e2-b7c5-c95146376232')).toBe(
      '2176507c-3e3a-80e2-b7c5-c95146376232',
    );
  });

  test('inserts dashes into 32-hex bare id', () => {
    expect(normalizePageId('2176507c3e3a80e2b7c5c95146376232')).toBe(
      '2176507c-3e3a-80e2-b7c5-c95146376232',
    );
  });

  test('returns null for non-id input', () => {
    expect(normalizePageId('not-a-uuid')).toBeNull();
  });
});

describe('extractPageIdFromSlug', () => {
  test('notion.site path slug with trailing 32-hex (Diligent)', () => {
    expect(
      extractPageIdFromSlug('Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232'),
    ).toBe('2176507c-3e3a-80e2-b7c5-c95146376232');
  });

  test('notion.site path slug (Argil)', () => {
    expect(
      extractPageIdFromSlug('Argil-Careers-1f8b7403d89448c3be95c7500b79087f'),
    ).toBe('1f8b7403-d894-48c3-be95-c7500b79087f');
  });

  test('notion.so workspace:uuid slug', () => {
    expect(extractPageIdFromSlug('anthropic:3b3c91be9aac4d5ca58d2e8e1c0a82c0')).toBe(
      '3b3c91be-9aac-4d5c-a58d-2e8e1c0a82c0',
    );
  });

  test('notion.so dashed uuid slug', () => {
    expect(
      extractPageIdFromSlug('myworkspace:3b3c91be-9aac-4d5c-a58d-2e8e1c0a82c0'),
    ).toBe('3b3c91be-9aac-4d5c-a58d-2e8e1c0a82c0');
  });

  test('returns null when no page id present', () => {
    expect(extractPageIdFromSlug('truemetrics-jobs')).toBeNull();
  });
});

describe('extractPageIdFromHtml', () => {
  test('parses pageId from notion.site SPA shell (Diligent)', () => {
    expect(extractPageIdFromHtml(loadText('diligent.html'))).toBe(
      '2176507c-3e3a-80e2-b7c5-c95146376232',
    );
  });

  test('parses pageId from notion.site SPA shell (Argil)', () => {
    expect(extractPageIdFromHtml(loadText('argil.html'))).toBe(
      '1f8b7403-d894-48c3-be95-c7500b79087f',
    );
  });

  test('returns null when html has no pageId', () => {
    expect(extractPageIdFromHtml('<html><body>nothing</body></html>')).toBeNull();
  });
});

// ─── unwrapBlockValue handles legacy + modern shapes ─────────────────────────

describe('unwrapBlockValue', () => {
  test('unwraps legacy single-wrap shape', () => {
    const block = { role: 'reader', value: { id: 'a', type: 'page' } };
    expect(unwrapBlockValue(block)).toEqual({ id: 'a', type: 'page' });
  });

  test('unwraps modern double-wrap shape', () => {
    const block = { spaceId: 's', value: { value: { id: 'a', type: 'page' } } };
    expect(unwrapBlockValue(block)).toEqual({ id: 'a', type: 'page' });
  });

  test('returns null for empty block', () => {
    expect(unwrapBlockValue({})).toBeNull();
    expect(unwrapBlockValue(null)).toBeNull();
  });
});

// ─── Job extraction per fixture ───────────────────────────────────────────────

describe('extractJobsFromRecordMap — Diligent', () => {
  test('extracts 4 inline collection-row pages from page chunk', () => {
    const chunk = loadJson<RecordMapWrapper>('diligent-chunk.json');
    // biome: chunk.recordMap.block is intentionally `unknown`-typed here; the
    // runtime shape is a Record<string, NotionBlock>.
    const jobs = extractJobsFromRecordMap(
      chunk.recordMap?.block as never,
    );

    expect(jobs.length).toBeGreaterThanOrEqual(4);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Fullstack Engineer');
    expect(titles).toContain('Senior ML / AI Engineer');
    expect(titles).toContain('GTM associate');

    // Every job must have a non-empty title and a stable 8-char providerJobId.
    for (const job of jobs) {
      expect(job.title.length).toBeGreaterThan(0);
      expect(job.providerJobId).toMatch(/^[a-f0-9]{8}$/);
      expect(job.provider).toBe('notion');
    }
  });
});

describe('extractJobsFromRecordMap — GetCrux', () => {
  test('extracts ≥1 real job from queryCollection response', () => {
    const coll = loadJson<RecordMapWrapper>('getcrux-coll.json');
    const jobs = extractJobsFromRecordMap(coll.recordMap?.block as never);

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const sde = jobs.find((j) => j.title.includes('SDE2/3'));
    expect(sde).toBeDefined();
    expect(sde?.title.length ?? 0).toBeGreaterThan(0);
  });
});

describe('extractJobsFromRecordMap — Argil (zero openings)', () => {
  test('returns 0 jobs (page literally says "not actively recruiting")', () => {
    const chunk = loadJson<RecordMapWrapper>('argil-chunk.json');
    const jobs = extractJobsFromRecordMap(chunk.recordMap?.block as never);
    expect(jobs).toHaveLength(0);
  });
});

describe('extractJobsFromRecordMap — Truemetrics (empty collection)', () => {
  test('queryCollection result is empty → 0 jobs', () => {
    const coll = loadJson<RecordMapWrapper>('truemetrics-coll.json');
    // truemetrics-coll.json's recordMap.block may be undefined (empty result).
    const jobs = extractJobsFromRecordMap(coll.recordMap?.block as never);
    expect(jobs).toHaveLength(0);
  });
});

// ─── findCollectionViews ──────────────────────────────────────────────────────

describe('findCollectionViews', () => {
  test('finds collection_view_page in truemetrics chunk', () => {
    const chunk = loadJson<RecordMapWrapper>('truemetrics-chunk.json');
    const refs = findCollectionViews(chunk.recordMap?.block as never);

    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].collectionId).toBe('28e36b1e-f995-80c1-b61b-000b2de6a3ec');
    expect(refs[0].viewId).toBe('28e36b1e-f995-8062-9fc4-000c2cec267f');
    expect(refs[0].spaceId).toBeTruthy();
  });

  test('finds collection_view in getcrux chunk', () => {
    const chunk = loadJson<RecordMapWrapper>('getcrux-chunk.json');
    const refs = findCollectionViews(chunk.recordMap?.block as never);

    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].collectionId).toBe('6f6a1209-1837-4fcb-9039-8dadaca92300');
  });

  test('returns 0 refs when no collection blocks present (Argil)', () => {
    const chunk = loadJson<RecordMapWrapper>('argil-chunk.json');
    const refs = findCollectionViews(chunk.recordMap?.block as never);
    expect(refs).toHaveLength(0);
  });
});

// ─── End-to-end fetchNotion via mocked fetch ─────────────────────────────────

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function installFetchMock(handler: FetchHandler): () => void {
  const g = globalThis as typeof globalThis & { fetch: typeof fetch };
  const orig = g.fetch;
  g.fetch = (async (input, init) => handler(input, init)) as typeof fetch;
  return () => {
    g.fetch = orig;
  };
}

function asUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

describe('fetchNotion (mocked) — modern *.notion.site SPA path', () => {
  test('Diligent: HTML shell + page chunk → 4+ jobs', async () => {
    const html = loadText('diligent.html');
    const chunk = loadText('diligent-chunk.json');

    const restore = installFetchMock((input) => {
      const url = asUrl(input);
      if (url.includes('/api/v3/loadPageChunk')) {
        return new Response(chunk, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const jobs = await fetchNotion(
        'Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232',
      );
      expect(jobs.length).toBeGreaterThanOrEqual(4);
      const titles = jobs.map((j) => j.title);
      expect(titles).toContain('Fullstack Engineer');
    } finally {
      restore();
    }
  });

  test('GetCrux: HTML shell + chunk + queryCollection → ≥1 job', async () => {
    const html = loadText('getcrux.html');
    const chunk = loadText('getcrux-chunk.json');
    const coll = loadText('getcrux-coll.json');

    const restore = installFetchMock((input) => {
      const url = asUrl(input);
      if (url.includes('/api/v3/queryCollection')) {
        return new Response(coll, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/v3/loadPageChunk')) {
        return new Response(chunk, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const jobs = await fetchNotion(
        'Job-Board-Crux-YC-W24-d28060539085494e8ac1537f91a5f329',
      );
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      const sde = jobs.find((j) => j.title.includes('SDE2/3'));
      expect(sde).toBeDefined();
    } finally {
      restore();
    }
  });

  test('Argil (zero openings): HTML shell + chunk → 0 jobs (not an error)', async () => {
    const html = loadText('argil.html');
    const chunk = loadText('argil-chunk.json');

    const restore = installFetchMock((input) => {
      const url = asUrl(input);
      if (url.includes('/api/v3/loadPageChunk')) {
        return new Response(chunk, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const jobs = await fetchNotion(
        'Argil-Careers-1f8b7403d89448c3be95c7500b79087f',
      );
      expect(jobs).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('Truemetrics (no listings): chunk + empty queryCollection → 0 jobs', async () => {
    const html = loadText('truemetrics.html');
    const chunk = loadText('truemetrics-chunk.json');
    const coll = loadText('truemetrics-coll.json');

    const restore = installFetchMock((input) => {
      const url = asUrl(input);
      if (url.includes('/api/v3/queryCollection')) {
        return new Response(coll, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/v3/loadPageChunk')) {
        return new Response(chunk, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    try {
      const jobs = await fetchNotion('truemetrics-jobs');
      expect(jobs).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

// ─── Issue #34: *.notion.site workspace subdomain detect → buildUrl roundtrip ─

describe('detect → buildUrl roundtrip (issue #34)', () => {
  // The bug: detect.ts captured only the path, dropping the workspace subdomain.
  // The stored slug then rebuilt to notion.so/<path> (no workspace, no 32-hex id),
  // which Notion 401s. Fix: capture workspace too, store as "workspace:path".

  test('detect: truemetrics URL → workspace:path slug', () => {
    const result = detectFromText('https://truemetrics-io.notion.site/truemetrics-jobs');
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('truemetrics-io:truemetrics-jobs');
  });

  test('buildUrl: workspace:path slug → *.notion.site URL', () => {
    expect(buildUrl('truemetrics-io:truemetrics-jobs')).toBe(
      'https://truemetrics-io.notion.site/truemetrics-jobs',
    );
  });

  test('buildUrl: legacy bare path slug with 32-hex → notion.so URL unchanged', () => {
    expect(buildUrl('Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232')).toBe(
      'https://www.notion.so/Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232',
    );
  });

  test('buildUrl: notion.so workspace:uuid slug → notion.so URL unchanged', () => {
    expect(buildUrl('anthropic:3b3c91be9aac4d5ca58d2e8e1c0a82c0')).toBe(
      'https://www.notion.so/anthropic/3b3c91be9aac4d5ca58d2e8e1c0a82c0',
    );
  });

  test('buildUrl: workspace:path-with-32hex-suffix → notion.so URL (Diligent new-slug form)', () => {
    expect(buildUrl('diligentai:Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232')).toBe(
      'https://www.notion.so/diligentai/Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232',
    );
  });
});
