import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { hasAITag, mapCompany } from '../scrapers/yc';

describe('YC scraper', () => {
  test('hasAITag filters correctly', () => {
    expect(hasAITag(['SaaS', 'B2B'])).toBe(false);
    expect(hasAITag(['Artificial Intelligence', 'SaaS'])).toBe(true);
    expect(hasAITag(['LLM', 'Generative AI'])).toBe(true);
    expect(hasAITag(['Machine Learning'])).toBe(true);
    expect(hasAITag(['Robotics'])).toBe(true);
    expect(hasAITag(['fintech', 'payments'])).toBe(false);
  });

  test('mapCompany transforms correctly', () => {
    const fixture = {
      id: 12345,
      name: 'Test AI Co',
      slug: 'test-ai-co',
      website: 'https://test.ai',
      small_logo_thumb_url: 'https://example.com/logo.png',
      one_liner: 'AI for everyone',
      batch: 'Summer 2024',
      tags: ['ai', 'saas'],
    };

    const result = mapCompany(fixture, 'https://test.ai/careers');

    expect(result.id).toBe('test-ai-co');
    expect(result.slug).toBe('test-ai-co');
    expect(result.name).toBe('Test AI Co');
    expect(result.yc_batch).toBe('Summer 2024');
    expect(result.website).toBe('https://test.ai');
    expect(result.logo_url).toBe('https://example.com/logo.png');
    expect(result.description).toBe('AI for everyone');
    expect(result.careers_url).toBe('https://test.ai/careers');
    expect(result.created_at).toBeGreaterThan(0);
  });

  test('upsert is idempotent', () => {
    const db = new Database(':memory:');
    
    db.exec(`
      CREATE TABLE companies (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        yc_batch TEXT,
        website TEXT,
        logo_url TEXT,
        description TEXT,
        careers_url TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const upsertStmt = db.prepare(`
      INSERT INTO companies (id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        yc_batch = excluded.yc_batch,
        website = excluded.website,
        logo_url = excluded.logo_url,
        description = excluded.description,
        careers_url = excluded.careers_url
    `);

    const company = {
      id: 'test-co',
      slug: 'test-co',
      name: 'Test Co',
      yc_batch: 'W24',
      website: 'https://test.co',
      logo_url: null,
      description: 'Test company',
      careers_url: 'https://test.co/careers',
      created_at: Date.now(),
    };

    upsertStmt.run(
      company.id,
      company.slug,
      company.name,
      company.yc_batch,
      company.website,
      company.logo_url,
      company.description,
      company.careers_url,
      company.created_at
    );

    const countAfterFirst = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };
    expect(countAfterFirst.count).toBe(1);

    // run again
    upsertStmt.run(
      company.id,
      company.slug,
      'Test Co Updated',
      company.yc_batch,
      company.website,
      company.logo_url,
      'Updated description',
      company.careers_url,
      company.created_at
    );

    const countAfterSecond = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };
    expect(countAfterSecond.count).toBe(1);

    const updated = db.query('SELECT name, description FROM companies WHERE slug = ?').get('test-co') as {
      name: string;
      description: string;
    };
    expect(updated.name).toBe('Test Co Updated');
    expect(updated.description).toBe('Updated description');

    db.close();
  });
});
