import { describe, expect, test } from 'bun:test';
import { htmlDecode } from '../scrapers/ats/normalize';
import { fetchGreenhouse } from '../scrapers/ats/greenhouse';

describe('htmlDecode', () => {
  test('decodes mixed HTML entities', () => {
    const input = '&lt;p&gt;Hello &amp; goodbye, &quot;friend&quot;&lt;/p&gt;&nbsp;';
    const expected = '<p>Hello & goodbye, "friend"</p> ';
    expect(htmlDecode(input)).toBe(expected);
  });

  test('decodes numeric entities', () => {
    const input = '&#39;quoted&#39;';
    const expected = "'quoted'";
    expect(htmlDecode(input)).toBe(expected);
  });

  test('decodes hex entities', () => {
    const input = '&#x27;hex&#x27;';
    const expected = "'hex'";
    expect(htmlDecode(input)).toBe(expected);
  });

  test('preserves double-encoded amp (decodes only once)', () => {
    const input = '&amp;lt;';
    const expected = '&lt;';
    expect(htmlDecode(input)).toBe(expected);
  });

  test('decodes complex real-world example', () => {
    const input = '&lt;div&gt;&lt;h2&gt;About Us&lt;/h2&gt;&lt;p&gt;We&#39;re hiring &amp; growing fast!&lt;/p&gt;&lt;/div&gt;';
    const expected = "<div><h2>About Us</h2><p>We're hiring & growing fast!</p></div>";
    expect(htmlDecode(input)).toBe(expected);
  });

  test('handles empty string', () => {
    expect(htmlDecode('')).toBe('');
  });

  test('handles string with no entities', () => {
    const input = 'Plain text with no entities';
    expect(htmlDecode(input)).toBe(input);
  });

  test('decodes &apos; entity', () => {
    const input = 'It&apos;s working';
    const expected = "It's working";
    expect(htmlDecode(input)).toBe(expected);
  });

  test('decodes multiple &nbsp; entities', () => {
    const input = 'Word&nbsp;&nbsp;&nbsp;spacing';
    const expected = 'Word   spacing';
    expect(htmlDecode(input)).toBe(expected);
  });
});

describe('fetchGreenhouse integration', () => {
  test('returns decoded HTML from encoded content', async () => {
    const mockResponse = {
      jobs: [
        {
          id: 12345,
          title: 'Senior Engineer',
          location: { name: 'San Francisco, CA' },
          content: '&lt;p&gt;Join our team!&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Build &amp; ship&lt;/li&gt;&lt;/ul&gt;',
          absolute_url: 'https://boards.greenhouse.io/test/jobs/12345',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      const jobs = await fetchGreenhouse('test-company');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].description).toStartWith('<p>');
      expect(jobs[0].description).not.toContain('&lt;');
      expect(jobs[0].description).toContain('Build & ship');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('handles empty content gracefully', async () => {
    const mockResponse = {
      jobs: [
        {
          id: 67890,
          title: 'Product Manager',
          location: null,
          content: null,
          absolute_url: null,
          updated_at: null,
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      const jobs = await fetchGreenhouse('test-company');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].description).toBe('');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
