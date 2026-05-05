import type { Database } from 'bun:sqlite';
import { THIRTY_DAYS_MS, type ListingDraft, type Tier } from './stripe';
import { slugify } from './jobs';

/**
 * Insert a paid listing in a single transaction. Idempotent on `eventId`.
 *
 * Returns `'inserted'` on the first call for an event, `'duplicate'` on replays,
 * which the webhook handler maps to a 200 response either way.
 */
export type FulfillInput = {
  draft: ListingDraft;
  tier: Tier;
  amountCents: number;
  currency: string;
  sessionId: string;
  eventId: string;
  paidAt: number; // ms epoch
};

export type FulfillResult = 'inserted' | 'duplicate';

const COMPANY_PREFIX = 'co';
const LISTING_PREFIX = 'lst';
const PAID_PREFIX = 'pay';

function makeId(prefix: string): string {
  // Compact prefix + uuidv4 (no dashes) keeps these readable in logs while still globally unique.
  const rand = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${rand}`;
}

function normalizeWebsite(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

function uniqueSlug(db: Database, base: string): string {
  const root = slugify(base) || 'company';
  let candidate = root;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM companies WHERE slug = ?').get(candidate)) {
    candidate = `${root}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function findOrCreateCompany(db: Database, draft: ListingDraft, now: number): string {
  const normalizedSite = normalizeWebsite(draft.company_website);
  const existing = db
    .prepare('SELECT id FROM companies WHERE LOWER(website) = ? OR website = ? LIMIT 1')
    .get(normalizedSite, draft.company_website) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = makeId(COMPANY_PREFIX);
  const slug = uniqueSlug(db, draft.company_name);
  db.prepare(
    `INSERT INTO companies (id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at)
     VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
  ).run(id, slug, draft.company_name, draft.company_website, now);
  return id;
}

export function fulfillPaidListing(db: Database, input: FulfillInput): FulfillResult {
  const txn = db.transaction((): FulfillResult => {
    // Idempotency: if we already processed this event, bail without touching anything else.
    const existingEvent = db
      .prepare('SELECT 1 FROM paid_listings WHERE stripe_event_id = ?')
      .get(input.eventId);
    if (existingEvent) return 'duplicate';

    const now = input.paidAt;
    const companyId = findOrCreateCompany(db, input.draft, now);
    const listingId = makeId(LISTING_PREFIX);

    db.prepare(
      `INSERT INTO listings (
        id, company_id, title, location_city, location_country, location_is_remote,
        location_policy, comp_min, comp_max, comp_currency, comp_equity, ai_stack,
        ai_specialty, ai_compute_access, description_html, apply_url, posted_at,
        expires_at, updated_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      listingId,
      companyId,
      input.draft.title,
      input.draft.location_city,
      input.draft.location_country,
      input.draft.location_is_remote,
      input.draft.location_policy,
      input.draft.comp_min,
      input.draft.comp_max,
      input.draft.comp_currency,
      JSON.stringify(input.draft.ai_stack),
      input.draft.ai_specialty,
      input.draft.description_html,
      input.draft.apply_url,
      now,
      now + THIRTY_DAYS_MS,
      now,
    );

    db.prepare(
      `INSERT INTO paid_listings (
        id, listing_id, stripe_session_id, stripe_event_id, tier,
        amount_cents, currency, customer_email, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      makeId(PAID_PREFIX),
      listingId,
      input.sessionId,
      input.eventId,
      input.tier,
      input.amountCents,
      input.currency,
      input.draft.customer_email,
      now,
    );

    return 'inserted';
  });

  return txn();
}
