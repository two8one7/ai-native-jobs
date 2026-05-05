import { describe, expect, test } from 'bun:test';
import { detectATS, detectFromText } from '../scrapers/ats/detect';

describe('ATS detection', () => {
  test('detects greenhouse boards URL', () => {
    expect(detectFromText('https://boards.greenhouse.io/openai')).toEqual({
      provider: 'greenhouse',
      slug: 'openai',
    });
  });

  test('detects greenhouse subdomain URL', () => {
    expect(detectFromText('https://openai.greenhouse.io/jobs')).toEqual({
      provider: 'greenhouse',
      slug: 'openai',
    });
  });

  test('detects greenhouse job-boards URL', () => {
    expect(detectFromText('https://job-boards.greenhouse.io/openai/jobs/123')).toEqual({
      provider: 'greenhouse',
      slug: 'openai',
    });
  });

  test('detects lever URL', () => {
    expect(detectFromText('https://jobs.lever.co/anthropic/123')).toEqual({
      provider: 'lever',
      slug: 'anthropic',
    });
  });

  test('detects ashby URL', () => {
    expect(detectFromText('https://jobs.ashbyhq.com/readme/0ff9b5e1-e97a-4216-a188-3dcbbd52cbe9')).toEqual({
      provider: 'ashby',
      slug: 'readme',
    });
  });

  test('detects provider from HTML body', () => {
    expect(detectFromText('<a href="https://jobs.lever.co/scaleai">Jobs</a>')).toEqual({
      provider: 'lever',
      slug: 'scaleai',
    });
  });

  test('returns null for malformed input', () => {
    expect(detectFromText('not a url')).toEqual({
      provider: null,
      slug: null,
    });
  });

  test('returns null for empty input', () => {
    expect(detectFromText('')).toEqual({
      provider: null,
      slug: null,
    });
  });

  test('returns null for null careers url', async () => {
    await expect(detectATS(null)).resolves.toEqual({
      provider: null,
      slug: null,
    });
  });
});
