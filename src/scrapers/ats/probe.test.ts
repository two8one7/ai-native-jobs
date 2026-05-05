import { describe, expect, test } from 'bun:test';
import { isPathAllowedByRobots, parseRobotsDisallowRules, shouldProbeCompany } from './probe';

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
