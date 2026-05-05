import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseCustomHtml } from './custom';

const FIXTURE_BASE = new URL('./__fixtures__/custom/', import.meta.url);
const CAREERS_URL = 'https://jobs.example.com/careers';

function loadFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_BASE), 'utf8');
}

describe('parseCustomHtml', () => {
  test('prefers JSON-LD JobPosting data', () => {
    const jobs = parseCustomHtml(loadFixture('jsonld-careers.html'), CAREERS_URL);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      provider: 'custom',
      title: 'Founding AI Engineer',
      location: 'San Francisco, US',
      applyUrl: 'https://jobs.example.com/careers/jobs/founding-ai-engineer',
      postedAt: '2026-05-01',
    });
    expect(jobs[1]).toMatchObject({
      title: 'Applied Scientist',
      location: 'Remote, US',
      applyUrl: 'https://jobs.example.com/openings/applied-scientist',
      postedAt: '2026-04-25',
    });
  });

  test('extracts same-origin anchors that look like job listings', () => {
    const jobs = parseCustomHtml(loadFixture('anchor-pattern-careers.html'), CAREERS_URL);

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.title)).toEqual([
      'Founding AI Engineer',
      'Platform ML Engineer',
    ]);
    expect(jobs.map((job) => job.location)).toEqual(['Remote, US', 'New York, NY']);
  });

  test('extracts heading and link pairs when anchors are generic', () => {
    const jobs = parseCustomHtml(loadFixture('heading-link-pair-careers.html'), CAREERS_URL);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: 'Research Engineer',
      location: 'Anywhere',
      applyUrl: 'https://jobs.example.com/positions/research-engineer',
    });
    expect(jobs[1]).toMatchObject({
      title: 'Inference Engineer',
      location: 'Hybrid',
      applyUrl: 'https://jobs.example.com/jobs/inference-engineer',
    });
  });

  test('returns no jobs for nav-only pages', () => {
    const jobs = parseCustomHtml(loadFixture('nav-only.html'), CAREERS_URL);
    expect(jobs).toEqual([]);
  });

  test('filters blacklisted anchor text', () => {
    const jobs = parseCustomHtml(loadFixture('anchor-pattern-careers.html'), CAREERS_URL);
    expect(jobs.some((job) => job.title === 'Privacy Policy')).toBeFalse();
  });
});
