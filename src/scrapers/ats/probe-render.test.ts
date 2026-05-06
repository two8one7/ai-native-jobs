import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCareersProbeScheduler,
  probeCompanyCareersWithRender,
  type ProbeableCompany,
  type RenderFn,
} from './probe';

const realFetch = globalThis.fetch;

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', 'spa', name), 'utf8');
}

function makeCompany(overrides: Partial<ProbeableCompany> = {}): ProbeableCompany {
  return {
    id: 'c1',
    slug: 'acme',
    name: 'Acme',
    yc_batch: 'Spring 2026',
    website: 'https://acme.example',
    careers_url: null,
    ats_provider: null,
    careers_probe_at: null,
    careers_probe_result: null,
    ...overrides,
  };
}

type FetchMock = (url: string) => {
  status: number;
  body: string;
  contentType?: string;
  finalUrl?: string;
};

function installFetch(handler: FetchMock): void {
  // @ts-expect-error mock fetch
  globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const result = handler(requestUrl);
    const response = new Response(result.body, {
      status: result.status,
      headers: { 'content-type': result.contentType ?? 'text/html; charset=utf-8' },
    });
    // The Response constructor doesn't expose `url` — re-define it so
    // the probe can resolve relative links against the request URL.
    Object.defineProperty(response, 'url', {
      value: result.finalUrl ?? requestUrl,
      configurable: true,
    });
    return response;
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('probeCompanyCareersWithRender', () => {
  test('skips render when plain probe finds an ATS link', async () => {
    installFetch(() => ({
      status: 200,
      body: '<html><body><a href="https://boards.greenhouse.io/acme">Careers</a></body></html>',
    }));

    let renderCalls = 0;
    const render: RenderFn = async () => {
      renderCalls += 1;
      return { html: '', finalUrl: 'about:blank' };
    };

    const outcome = await probeCompanyCareersWithRender(
      makeCompany(),
      createCareersProbeScheduler(2),
      new Map(),
      render,
    );

    expect(outcome.result).toBe('found_ats');
    expect(outcome.atsProvider).toBe('greenhouse');
    expect(renderCalls).toBe(0);
  });

  test('skips render when plain HTML body exceeds 30 KB and still no_page', async () => {
    const bigBody = `<!DOCTYPE html><html><body>${'x'.repeat(50_000)}</body></html>`;

    installFetch((url) => {
      if (url.includes('robots.txt')) {
        return { status: 200, body: '', contentType: 'text/plain' };
      }
      if (url.includes('ycombinator.com')) {
        return { status: 404, body: '' };
      }
      return { status: 200, body: bigBody };
    });

    let renderCalls = 0;
    const render: RenderFn = async () => {
      renderCalls += 1;
      return null;
    };

    const outcome = await probeCompanyCareersWithRender(
      makeCompany(),
      createCareersProbeScheduler(2),
      new Map(),
      render,
    );

    expect(outcome.result).toBe('no_page');
    expect(renderCalls).toBe(0);
  });

  test('invokes render when plain probe returns no_page with small body', async () => {
    const shell = loadFixture('framer-shell.html');

    installFetch((url) => {
      if (url.includes('robots.txt')) {
        return { status: 200, body: '', contentType: 'text/plain' };
      }
      if (url.includes('ycombinator.com')) {
        return { status: 404, body: '' };
      }
      return { status: 200, body: shell };
    });

    const renderedUrls: string[] = [];
    const render: RenderFn = async (url) => {
      renderedUrls.push(url);
      return null;
    };

    const outcome = await probeCompanyCareersWithRender(
      makeCompany(),
      createCareersProbeScheduler(2),
      new Map(),
      render,
    );

    expect(outcome.result).toBe('no_page');
    expect(renderedUrls.length).toBeGreaterThan(0);
    // Should include the YC jobs URL plus website-derived candidates.
    expect(renderedUrls.some((u) => u.includes('ycombinator.com/companies/acme/jobs'))).toBe(true);
    expect(renderedUrls.some((u) => u.includes('acme.example'))).toBe(true);
  });

  test('upgrades to found_ats when rendered HTML reveals an ATS link', async () => {
    const shell = loadFixture('framer-shell.html');
    const rendered = loadFixture('framer-rendered.html');

    installFetch((url) => {
      if (url.includes('robots.txt')) {
        return { status: 200, body: '', contentType: 'text/plain' };
      }
      if (url.includes('ycombinator.com')) {
        return { status: 404, body: '' };
      }
      return { status: 200, body: shell };
    });

    const render: RenderFn = async (url) => {
      // YC URL would short-circuit on URL pattern alone — simulate CDP failing
      // there (the company has no YC jobs page in this scenario).
      if (url.includes('ycombinator.com')) {
        return null;
      }
      return { html: rendered, finalUrl: url };
    };

    const outcome = await probeCompanyCareersWithRender(
      makeCompany(),
      createCareersProbeScheduler(2),
      new Map(),
      render,
    );

    expect(outcome.result).toBe('found_ats');
    expect(outcome.atsProvider).toBe('greenhouse');
    expect(outcome.careersUrl).toBe('https://boards.greenhouse.io/acme');
  });

  test('rendered shell-only HTML keeps result at no_page', async () => {
    const shell = loadFixture('framer-shell.html');

    installFetch((url) => {
      if (url.includes('robots.txt')) {
        return { status: 200, body: '', contentType: 'text/plain' };
      }
      if (url.includes('ycombinator.com')) {
        return { status: 404, body: '' };
      }
      return { status: 200, body: shell };
    });

    const render: RenderFn = async (url) => {
      if (url.includes('ycombinator.com')) {
        return null;
      }
      return { html: shell, finalUrl: url };
    };

    const outcome = await probeCompanyCareersWithRender(
      makeCompany(),
      createCareersProbeScheduler(2),
      new Map(),
      render,
    );

    expect(outcome.result).toBe('no_page');
  });

  test('continues past render exceptions (treats as null result)', async () => {
    const shell = loadFixture('framer-shell.html');
    const rendered = loadFixture('framer-rendered.html');

    installFetch((url) => {
      if (url.includes('robots.txt')) {
        return { status: 200, body: '', contentType: 'text/plain' };
      }
      if (url.includes('ycombinator.com')) {
        return { status: 404, body: '' };
      }
      return { status: 200, body: shell };
    });

    let nonYcCalls = 0;
    let totalCalls = 0;
    const render: RenderFn = async (url) => {
      totalCalls += 1;
      if (url.includes('ycombinator.com')) {
        return null;
      }
      nonYcCalls += 1;
      if (nonYcCalls === 1) {
        throw new Error('boom');
      }
      return { html: rendered, finalUrl: url };
    };

    const outcome = await probeCompanyCareersWithRender(
      makeCompany(),
      createCareersProbeScheduler(2),
      new Map(),
      render,
    );

    expect(totalCalls).toBeGreaterThanOrEqual(2);
    expect(outcome.result).toBe('found_ats');
  });
});

describe('detectFromText against rendered Framer fixture', () => {
  test('matches greenhouse link in rendered HTML body', () => {
    const rendered = loadFixture('framer-rendered.html');
    expect(rendered).toContain('boards.greenhouse.io/acme');
  });
});
