import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Company } from '../../db/types';
import { parseWaaSCompanyHtml, scrapeWaaS } from './waas';

const FIXTURE_BASE = new URL('./__fixtures__/waas/', import.meta.url);
const realFetch = globalThis.fetch;

function loadFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_BASE), 'utf8');
}

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'company-1',
    slug: 'corgi-insurance',
    name: 'Corgi Insurance',
    yc_batch: 'S24',
    website: 'https://example.com',
    logo_url: null,
    description: null,
    careers_url: 'https://www.workatastartup.com/companies/corgi-insurance',
    ats_provider: 'waas',
    careers_probe_at: null,
    careers_probe_result: 'found_ats',
    created_at: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.workatastartup.com/companies/corgi-insurance/jobs.json') {
      return new Response('not found', { status: 404 });
    }

    if (url === 'https://example.com/' || url === 'https://example.com/careers') {
      return new Response(loadFixture('corgi-embed.html'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url === 'https://www.workatastartup.com/companies/corgi-insurance') {
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

describe('parseWaaSCompanyHtml', () => {
  test('extracts rooted work at a startup apply urls from embed payloads', () => {
    const jobs = parseWaaSCompanyHtml(loadFixture('corgi-embed.html'), 'corgi-insurance');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      provider: 'waas',
      providerJobId: '88452',
      title: 'Full Stack Software Engineer',
      applyUrl:
        'https://www.workatastartup.com/companies/corgi-insurance/jobs/bJnshAq-full-stack-software-engineer',
    });
  });
});

describe('scrapeWaaS', () => {
  test('falls back from jobs.json to embedded waas html on the company website', async () => {
    const jobs = await scrapeWaaS(makeCompany());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].applyUrl).toBe(
      'https://www.workatastartup.com/companies/corgi-insurance/jobs/bJnshAq-full-stack-software-engineer',
    );
    expect(jobs[0].description.length).toBeGreaterThan(100);
  });

  test('uses jobs.json when the endpoint returns a list', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://www.workatastartup.com/companies/corgi-insurance/jobs.json') {
        return new Response(
          JSON.stringify([
            {
              id: 'signup-1',
              title: 'Applied AI Engineer',
              url: '/companies/corgi-insurance/jobs/applied-ai-engineer',
              location: 'Remote (US)',
              description:
                'Build reliable agentic workflows for underwriting, claims, and internal operations with strong product instincts and a bias for shipping.',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const jobs = await scrapeWaaS(makeCompany({ website: null }));
    expect(jobs).toEqual([
      expect.objectContaining({
        provider: 'waas',
        providerJobId: 'signup-1',
        title: 'Applied AI Engineer',
        applyUrl: 'https://www.workatastartup.com/companies/corgi-insurance/jobs/applied-ai-engineer',
      }),
    ]);
  });
});
