import { describe, expect, test } from 'bun:test';
import { detectFromText } from './detect';

describe('detectFromText — Notion URL patterns', () => {
  // #12: slug-prefixed notion.so page URLs (e.g. Anthropic-Careers-<uuid>)
  test('notion.so slug-prefixed page resolves to notion provider with bare UUID slug', () => {
    const result = detectFromText(
      'https://www.notion.so/anthropic/Anthropic-Careers-3b3c91be9aac4d5ca58d2e8e1c0a82c0',
    );
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('anthropic:3b3c91be9aac4d5ca58d2e8e1c0a82c0');
  });

  test('notion.so bare UUID page still resolves correctly', () => {
    const result = detectFromText(
      'https://www.notion.so/anthropic/3b3c91be9aac4d5ca58d2e8e1c0a82c0',
    );
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('anthropic:3b3c91be9aac4d5ca58d2e8e1c0a82c0');
  });

  test('notion.so dashed UUID still resolves correctly', () => {
    const result = detectFromText(
      'https://www.notion.so/myworkspace/3b3c91be-9aac-4d5c-a58d-2e8e1c0a82c0',
    );
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('myworkspace:3b3c91be-9aac-4d5c-a58d-2e8e1c0a82c0');
  });

  test('notion.site subdomain page resolves correctly', () => {
    const result = detectFromText('https://stripe.notion.site/jobs');
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('jobs');
  });
});

describe('detectFromText — Notion body patterns', () => {
  // #12: slug-prefixed notion.so link in HTML body should extract bare UUID
  test('slug-prefixed notion.so link in body resolves to notion provider with bare UUID slug', () => {
    const body = `<a href="https://www.notion.so/anthropic/Anthropic-Careers-3b3c91be9aac4d5ca58d2e8e1c0a82c0">Careers</a>`;
    const result = detectFromText(body);
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('anthropic:3b3c91be9aac4d5ca58d2e8e1c0a82c0');
  });

  test('bare UUID notion.so link in body still resolves correctly', () => {
    const body = `<a href="https://www.notion.so/anthropic/3b3c91be9aac4d5ca58d2e8e1c0a82c0">Careers</a>`;
    const result = detectFromText(body);
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('anthropic:3b3c91be9aac4d5ca58d2e8e1c0a82c0');
  });
});

describe('detectFromText — Notion careers-token guard (probe false-positive fix)', () => {
  // Real careers pages (the 4 issue-#33 fixtures) MUST still classify as notion.
  test('Diligent careers page routes to notion', () => {
    const result = detectFromText(
      'https://diligentai.notion.site/Careers-at-Diligent-2176507c3e3a80e2b7c5c95146376232',
    );
    expect(result.provider).toBe('notion');
    expect(result.slug).toContain('Careers-at-Diligent');
  });

  test('truemetrics jobs page routes to notion', () => {
    const result = detectFromText('https://truemetrics-io.notion.site/truemetrics-jobs');
    expect(result.provider).toBe('notion');
    expect(result.slug).toBe('truemetrics-jobs');
  });

  test('GetCrux job board routes to notion', () => {
    const result = detectFromText(
      'https://soft-kilometer-20c.notion.site/Job-Board-Crux-YC-W24-d28060539085494e8ac1537f91a5f329',
    );
    expect(result.provider).toBe('notion');
    expect(result.slug).toContain('Job-Board-Crux');
  });

  test('Argil careers page routes to notion', () => {
    const result = detectFromText(
      'https://argilai.notion.site/Argil-Careers-1f8b7403d89448c3be95c7500b79087f',
    );
    expect(result.provider).toBe('notion');
    expect(result.slug).toContain('Argil-Careers');
  });

  // Non-careers Notion pages — the documented probe false-positives — must NOT
  // route to notion now that the careers-token guard is in place.
  test('Berry Security one-pager does NOT route to notion', () => {
    const result = detectFromText(
      'https://example.notion.site/Berry-Security-2176507c3e3a80e2b7c5c95146376232',
    );
    expect(result.provider).not.toBe('notion');
  });

  test('Parea T&S page does NOT route to notion', () => {
    const result = detectFromText(
      'https://parea.notion.site/Terms-of-Service-2176507c3e3a80e2b7c5c95146376232',
    );
    expect(result.provider).not.toBe('notion');
  });

  test('Decohere guide does NOT route to notion', () => {
    const result = detectFromText(
      'https://decohere.notion.site/User-Guide-2176507c3e3a80e2b7c5c95146376232',
    );
    expect(result.provider).not.toBe('notion');
  });

  test('Persana T&S does NOT route to notion', () => {
    const result = detectFromText(
      'https://persana.notion.site/Privacy-Policy-2176507c3e3a80e2b7c5c95146376232',
    );
    expect(result.provider).not.toBe('notion');
  });

  // Word-boundary correctness: "rolex" should not satisfy the "role(s)?" token.
  test('"rolex" in slug does not satisfy "role" token (word boundaries)', () => {
    const result = detectFromText(
      'https://rolex.notion.site/Rolex-Watches-2176507c3e3a80e2b7c5c95146376232',
    );
    expect(result.provider).not.toBe('notion');
  });

  // Body-pattern guard: a notion.site link inside an HTML body must also be
  // gated by the careers-token check.
  test('non-careers notion.site link in body does not route to notion', () => {
    const body = `<a href="https://example.notion.site/Privacy-Policy-2176507c3e3a80e2b7c5c95146376232">Privacy</a>`;
    const result = detectFromText(body);
    expect(result.provider).not.toBe('notion');
  });

  test('careers-flavoured notion.site link in body DOES route to notion', () => {
    const body = `<a href="https://example.notion.site/We-Are-Hiring-2176507c3e3a80e2b7c5c95146376232">Jobs</a>`;
    const result = detectFromText(body);
    expect(result.provider).toBe('notion');
  });
});

describe('detectFromText — WaaS patterns', () => {
  test('work at a startup company url resolves to waas provider', () => {
    const result = detectFromText('https://www.workatastartup.com/companies/corgi-insurance');
    expect(result).toEqual({
      provider: 'waas',
      slug: 'corgi-insurance',
    });
  });

  test('relative work at a startup job link in body resolves to waas provider', () => {
    const result = detectFromText(
      '<a href="/companies/corgi-insurance/jobs/bJnshAq-full-stack-software-engineer">Apply</a>',
    );
    expect(result).toEqual({
      provider: 'waas',
      slug: 'corgi-insurance',
    });
  });
});
