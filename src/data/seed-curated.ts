import type { Database } from 'bun:sqlite';
import { CURATED_COMPANIES } from './curated-companies';

export function seedCurated(db: Database): number {
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

  const now = Date.now();
  let upsertedCount = 0;

  for (const company of CURATED_COMPANIES) {
    upsertStmt.run(
      `curated-${company.slug}`,
      company.slug,
      company.name,
      null,
      company.website,
      null,
      company.description,
      company.careers_url,
      now,
    );
    upsertedCount++;
  }

  return upsertedCount;
}
