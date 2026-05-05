import type { Database } from 'bun:sqlite';
import type { AIJobListing } from './types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function upsertListings(db: Database, listings: AIJobListing[]): number {
  if (listings.length === 0) {
    return 0;
  }

  const now = Date.now();
  const upsertStmt = db.prepare(`
    INSERT INTO listings (
      id, company_id, title, location_city, location_country, location_is_remote,
      location_policy, comp_min, comp_max, comp_currency, comp_equity, ai_stack,
      ai_specialty, ai_compute_access, description_html, apply_url, posted_at,
      expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      location_city = excluded.location_city,
      location_country = excluded.location_country,
      location_is_remote = excluded.location_is_remote,
      location_policy = excluded.location_policy,
      comp_min = excluded.comp_min,
      comp_max = excluded.comp_max,
      comp_currency = excluded.comp_currency,
      comp_equity = excluded.comp_equity,
      ai_stack = excluded.ai_stack,
      ai_specialty = excluded.ai_specialty,
      ai_compute_access = excluded.ai_compute_access,
      description_html = excluded.description_html,
      apply_url = excluded.apply_url,
      posted_at = excluded.posted_at,
      expires_at = ?,
      status = 'active'
  `);

  const transaction = db.transaction((rows: AIJobListing[]) => {
    for (const listing of rows) {
      upsertStmt.run(
        listing.id,
        listing.company_id,
        listing.title,
        listing.location_city,
        listing.location_country,
        listing.location_is_remote,
        listing.location_policy,
        listing.comp_min,
        listing.comp_max,
        listing.comp_currency,
        listing.comp_equity,
        listing.ai_stack,
        listing.ai_specialty,
        listing.ai_compute_access,
        listing.description_html,
        listing.apply_url,
        listing.posted_at,
        listing.expires_at,
        listing.status,
        now + THIRTY_DAYS_MS,
      );
    }
  });

  transaction(listings);
  return listings.length;
}
