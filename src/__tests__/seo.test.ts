import { describe, expect, test } from 'bun:test';
import { buildJobPostingJsonLd } from '../lib/seo';
import type { ListingListRow } from '../lib/db';

function makeListing(overrides: Partial<ListingListRow> = {}): ListingListRow {
  return {
    id: 'greenhouse:openai:123',
    title: 'Senior ML Engineer',
    location_city: 'San Francisco',
    location_country: 'US',
    location_is_remote: 0,
    location_policy: 'onsite',
    comp_min: null,
    comp_max: null,
    comp_currency: null,
    ai_stack: '',
    ai_specialty: null,
    description_html: '<p>Build things.</p>',
    apply_url: 'https://example.com/apply',
    posted_at: Date.parse('2026-04-01T00:00:00.000Z'),
    expires_at: Date.parse('2026-05-01T00:00:00.000Z'),
    updated_at: Date.parse('2026-04-01T00:00:00.000Z'),
    company_slug: 'openai',
    company_name: 'OpenAI',
    company_website: 'https://openai.com',
    company_description: null,
    ...overrides,
  };
}

describe('JobPosting JSON-LD', () => {
  test('emits jobLocation when country is concrete', () => {
    const ld = buildJobPostingJsonLd(makeListing({ location_country: 'US' }));
    expect(ld.jobLocation).toBeDefined();
    expect(ld.jobLocation?.address.addressCountry).toBe('US');
    expect(ld.jobLocation?.address.addressLocality).toBe('San Francisco');
  });

  test('drops jobLocation when country is the "Unknown" sentinel (#9)', () => {
    // Schema.org / Google Rich Results validators flag the literal "Unknown"
    // string in addressCountry. Better to omit the whole jobLocation subtree
    // than ship a sentinel that fails strict validation.
    const ld = buildJobPostingJsonLd(makeListing({ location_country: 'Unknown' }));
    expect(ld.jobLocation).toBeUndefined();
  });

  test('drops jobLocation when country is empty string', () => {
    const ld = buildJobPostingJsonLd(makeListing({ location_country: '' }));
    expect(ld.jobLocation).toBeUndefined();
  });

  test('drops jobLocation when listing is remote', () => {
    const ld = buildJobPostingJsonLd(
      makeListing({ location_is_remote: 1, location_policy: 'remote' }),
    );
    expect(ld.jobLocation).toBeUndefined();
    expect(ld.jobLocationType).toBe('TELECOMMUTE');
  });

  test('serializes to JSON without "Unknown" string anywhere', () => {
    // Defense-in-depth: anything we ship via JSON.stringify must not contain
    // the sentinel string in any field, even after future field additions.
    const ld = buildJobPostingJsonLd(
      makeListing({ location_country: 'Unknown', location_city: null }),
    );
    expect(JSON.stringify(ld)).not.toContain('Unknown');
  });
});
