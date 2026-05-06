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
