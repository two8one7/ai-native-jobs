import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { seedCurated } from '../data/seed-curated';
import { CURATED_COMPANIES } from '../data/curated-companies';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

describe('curated company seeding', () => {
  test('is idempotent and preserves created_at', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    const firstCount = seedCurated(db);
    expect(firstCount).toBe(CURATED_COMPANIES.length);

    const totalAfterFirst = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };
    expect(totalAfterFirst.count).toBe(CURATED_COMPANIES.length);

    const astrocadeFirst = db
      .query('SELECT slug, name, yc_batch, created_at FROM companies WHERE slug = ?')
      .get('astrocade') as { slug: string; name: string; yc_batch: string | null; created_at: number };
    
    expect(astrocadeFirst.slug).toBe('astrocade');
    expect(astrocadeFirst.name).toBe('Astrocade');
    expect(astrocadeFirst.yc_batch).toBeNull();
    const firstCreatedAt = astrocadeFirst.created_at;

    const secondCount = seedCurated(db);
    expect(secondCount).toBe(CURATED_COMPANIES.length);

    const totalAfterSecond = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };
    expect(totalAfterSecond.count).toBe(CURATED_COMPANIES.length);

    const astrocadeSecond = db
      .query('SELECT slug, name, yc_batch, created_at FROM companies WHERE slug = ?')
      .get('astrocade') as { slug: string; name: string; yc_batch: string | null; created_at: number };

    expect(astrocadeSecond.created_at).toBe(firstCreatedAt);

    db.close();
  });

  test('Astrocade has correct data and yc_batch is null', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    seedCurated(db);

    const astrocade = db
      .query('SELECT id, slug, name, yc_batch, website, careers_url FROM companies WHERE slug = ?')
      .get('astrocade') as {
        id: string;
        slug: string;
        name: string;
        yc_batch: string | null;
        website: string;
        careers_url: string;
      };

    expect(astrocade).toBeDefined();
    expect(astrocade.id).toBe('curated-astrocade');
    expect(astrocade.slug).toBe('astrocade');
    expect(astrocade.name).toBe('Astrocade');
    expect(astrocade.yc_batch).toBeNull();
    expect(astrocade.website).toBe('https://astrocade.com');
    expect(astrocade.careers_url).toBe('https://jobs.ashbyhq.com/astrocade');

    db.close();
  });
});
