import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createCareersProbeScheduler,
  isPathAllowedByRobots,
  parseRobotsDisallowRules,
  probeCompanyCareers,
  shouldProbeCompany,
} from './probe';

const FIXTURE_BASE = new URL('./__fixtures__/waas/', import.meta.url);
const realFetch = globalThis.fetch;

function loadFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_BASE), 'utf8');
}

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://example.com/robots.txt') {
      return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    if (url === 'https://example.com/') {
      return new Response(loadFixture('corgi-embed.html'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('careers probe robots handling', () => {
  test('prefers explicit user-agent group over wildcard', () => {
    const robots = `
User-agent: *
Disallow: /blocked-for-all

User-agent: ai-native-jobs-scraper
Disallow: /careers
Disallow: /jobs/private
`;

    expect(parseRobotsDisallowRules(robots)).toEqual(['/careers', '/jobs/private']);
    expect(isPathAllowedByRobots(robots, '/careers')).toBe(false);
    expect(isPathAllowedByRobots(robots, '/jobs')).toBe(true);
  });
});

describe('careers probe cache policy', () => {
  test('skips recent negative probes', () => {
    const now = Date.now();
    expect(
      shouldProbeCompany({
        id: '1',
        slug: 'test',
        name: 'Test',
        yc_batch: 'Spring 2026',
        website: 'https://example.com',
        careers_url: null,
        ats_provider: null,
        careers_probe_at: now - 5 * 24 * 60 * 60 * 1000,
        careers_probe_result: 'no_page',
      }, now),
    ).toBe(false);
  });

  test('retries stale negative probes', () => {
    const now = Date.now();
    expect(
      shouldProbeCompany({
        id: '1',
        slug: 'test',
        name: 'Test',
        yc_batch: 'Spring 2026',
        website: 'https://example.com',
        careers_url: null,
        ats_provider: null,
        careers_probe_at: now - 31 * 24 * 60 * 60 * 1000,
        careers_probe_result: 'blocked',
      }, now),
    ).toBe(true);
  });

  test('skips companies that already have careers_url', () => {
    expect(
      shouldProbeCompany({
        id: '1',
        slug: 'test',
        name: 'Test',
        yc_batch: 'Spring 2026',
        website: 'https://example.com',
        careers_url: 'https://example.com/careers',
        ats_provider: 'custom',
        careers_probe_at: null,
        careers_probe_result: null,
      }),
    ).toBe(false);
  });
});

describe('careers probe waas detection', () => {
  test('promotes waas embeds to the canonical work at a startup company page', async () => {
    const scheduler = createCareersProbeScheduler(1);
    const robotsCache = new Map<string, { disallow: string[] }>();
    const outcome = await probeCompanyCareers(
      {
        id: '1',
        slug: 'corgi-insurance',
        name: 'Corgi Insurance',
        yc_batch: 'S24',
        website: 'https://example.com',
        careers_url: null,
        ats_provider: null,
        careers_probe_at: null,
        careers_probe_result: null,
      },
      scheduler,
      robotsCache,
    );

    expect(outcome.atsProvider).toBe('waas');
    expect(outcome.result).toBe('found_ats');
    expect(outcome.careersUrl).toBe('https://www.workatastartup.com/companies/corgi-insurance');
  });
});
