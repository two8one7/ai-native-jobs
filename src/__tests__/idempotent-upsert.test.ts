import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { normalizeRawJob } from '../scrapers/ats/normalize';
import { upsertListings } from '../scrapers/ats/store';
import type { RawJob } from '../scrapers/ats';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

describe('ATS listing upsert', () => {
  test('is idempotent and updates changed fields', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);

    db.prepare(
      `INSERT INTO companies (
        id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'company-1',
      'openai',
      'OpenAI',
      'W24',
      'https://openai.com',
      null,
      'AI company',
      'https://boards.greenhouse.io/openai',
      Date.now(),
    );

    const rawJob: RawJob = {
      provider: 'greenhouse',
      providerJobId: '123',
      title: 'Inference Engineer',
      location: 'Remote',
      description:
        '<p>Build CUDA inference systems for our production ML platform. Optimize GPU kernels, reduce latency, and scale our serving infrastructure to handle millions of requests per day.</p>',
      applyUrl: 'https://boards.greenhouse.io/openai/jobs/123',
      postedAt: '2026-04-01T00:00:00.000Z',
    };

    const first = normalizeRawJob(rawJob, {
      companyId: 'company-1',
      provider: 'greenhouse',
      providerSlug: 'openai',
    });
    upsertListings(db, [first]);

    const second = normalizeRawJob(
      {
        ...rawJob,
        title: 'Senior Inference Engineer',
      },
      {
        companyId: 'company-1',
        provider: 'greenhouse',
        providerSlug: 'openai',
      },
    );
    upsertListings(db, [second]);

    const count = db.query('SELECT COUNT(*) as count FROM listings').get() as { count: number };
    const row = db
      .query('SELECT title FROM listings WHERE id = ?')
      .get('greenhouse:openai:123') as { title: string };

    expect(count.count).toBe(1);
    expect(row.title).toBe('Senior Inference Engineer');
    db.close();
  });
});
