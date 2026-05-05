import { describe, expect, test } from 'bun:test';
import { normalizeRawJob } from '../scrapers/ats/normalize';
import type { RawJob } from '../scrapers/ats';

const context = {
  companyId: 'company-1',
  provider: 'greenhouse' as const,
  providerSlug: 'openai',
};

describe('ATS normalization', () => {
  test('normalizes greenhouse job', () => {
    const rawJob: RawJob = {
      provider: 'greenhouse',
      providerJobId: '123',
      title: 'Senior ML Engineer',
      location: 'Remote, US',
      description:
        '<p>Build PyTorch and CUDA systems with equity. Compensation: $180k - $250k.</p>',
      applyUrl: 'https://boards.greenhouse.io/openai/jobs/123',
      postedAt: '2026-04-01T00:00:00.000Z',
    };

    const listing = normalizeRawJob(rawJob, context);
    expect(listing.id).toBe('greenhouse:openai:123');
    expect(listing.company_id).toBe('company-1');
    expect(listing.title).toBe('Senior ML Engineer');
    expect(listing.location_country).toBe('US');
    expect(listing.location_policy).toBe('remote');
    expect(listing.location_is_remote).toBe(1);
    expect(listing.description_html.length).toBeGreaterThan(0);
    expect(listing.apply_url).toBe(rawJob.applyUrl);
    expect(listing.status).toBe('active');
    expect(listing.comp_min).toBe(180000);
    expect(listing.comp_max).toBe(250000);
    expect(listing.comp_currency).toBe('USD');
    expect(listing.comp_equity).toBe(1);
    expect(JSON.parse(listing.ai_stack)).toEqual(expect.arrayContaining(['pytorch', 'cuda']));
  });

  test('normalizes lever job', () => {
    const rawJob: RawJob = {
      provider: 'lever',
      providerJobId: 'abc',
      title: 'Applied Scientist',
      location: 'Hybrid - New York, US',
      description:
        '<div onclick="alert(1)">Train transformers and RLHF systems for natural language tasks.</div>',
      applyUrl: 'https://jobs.lever.co/company/abc',
      postedAt: 1_712_000_000_000,
    };

    const listing = normalizeRawJob(rawJob, {
      ...context,
      provider: 'lever',
      providerSlug: 'company',
    });

    expect(listing.id).toBe('lever:company:abc');
    expect(listing.location_city).toBe('New York');
    expect(listing.location_country).toBe('US');
    expect(listing.location_policy).toBe('hybrid');
    expect(listing.location_is_remote).toBe(1);
    expect(listing.ai_specialty).toBe('nlp');
    expect(listing.description_html.includes('onclick')).toBe(false);
    expect(JSON.parse(listing.ai_stack)).toEqual(
      expect.arrayContaining(['transformers', 'rlhf']),
    );
  });

  test('normalizes ashby job', () => {
    const rawJob: RawJob = {
      provider: 'ashby',
      providerJobId: 'def',
      title: 'Robotics Software Engineer',
      location: 'San Francisco, United States',
      description: '<p>Work on robotics perception with JAX and Triton.</p>',
      applyUrl: 'https://jobs.ashbyhq.com/robotco/def',
      postedAt: '2026-04-10',
    };

    const listing = normalizeRawJob(rawJob, {
      ...context,
      provider: 'ashby',
      providerSlug: 'robotco',
    });

    expect(listing.id).toBe('ashby:robotco:def');
    expect(listing.location_city).toBe('San Francisco');
    expect(listing.location_country).toBe('United States');
    expect(listing.location_policy).toBe('onsite');
    expect(listing.location_is_remote).toBe(0);
    expect(listing.ai_specialty).toBe('robotics');
    expect(JSON.parse(listing.ai_stack)).toEqual(expect.arrayContaining(['jax', 'triton']));
    expect(listing.posted_at).toBeGreaterThan(0);
    expect(listing.expires_at).toBeGreaterThan(listing.posted_at);
  });
});
