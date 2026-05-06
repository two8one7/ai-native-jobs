/**
 * backfill-descriptions.ts
 *
 * Back-fills empty descriptions for active listings created by the
 * generic-careers ingest path.
 *
 * Root cause: `src/scrapers/ats/custom.ts` discovers job listings by parsing a
 * careers index page (anchor-pattern + heading-pair extraction) and builds
 * per-listing stubs with `description: ''`. Individual job detail pages are
 * never fetched at scrape time, so the stored `description_html` is blank.
 * Companies whose careers page was found this way have `ats_provider IS NULL`
 * on the `companies` row — the probe set `careers_url` but the ATS scraper
 * resolved it as a generic custom page without a named provider.
 *
 * This script:
 *  1. Selects active listings where `length(description_html) < 50`.
 *  2. Fetches each listing's `apply_url` with a plain HTTP GET (no headless
 *     Chrome — SPA pages return empty and get expired; issue #17 handles those).
 *  3. Extracts the main content body via a priority heuristic.
 *  4. Sanitizes the HTML and writes it back if it contains >= 200 chars of text.
 *  5. Expires listings that still have no extractable body.
 *
 * Run: bun run backfill:descriptions
 * DO NOT run automatically. Brain runs this interactively after review.
 */

import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { parse } from 'node-html-parser';
import { sanitizeHtml, stripTags } from '../scrapers/ats/normalize';
import { openDbWrite } from '../lib/db-write';

const DB_PATH = resolve(process.env.AINATIVE_DB_PATH ?? './data/ai-native-jobs.db');
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_DELAY_MS = 250;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ai-native-jobs-bot/0.1; +https://ai-native-jobs.tommyato.com)';
const MIN_FILLED_CHARS = 200;

export type EmptyListing = {
  id: string;
  title: string;
  apply_url: string;
  company_id: string;
};

export type FetchImpl = (url: string) => Promise<{ html: string | null; permanentlyDead: boolean; status?: number }>;

export type ProcessOutcome = 'filled' | 'expired' | 'error';

export function expireListing(db: Database, listingId: string, expiredAt = Date.now()): void {
  db.prepare(`UPDATE listings SET expires_at = ? WHERE id = ?`).run(expiredAt, listingId);
}

/**
 * Extract the main content from an HTML page using a priority heuristic:
 *  1. `<article>` element body
 *  2. `<main>` element body
 *  3. h1 + sibling-elements after the first heading (within the same parent)
 *  4. `<body>` content as last resort
 *
 * Returns raw (unsanitized) HTML. Callers are responsible for sanitizing.
 */
export function extractMainContent(html: string): string {
  const root = parse(html);

  // 1. <article>
  const article = root.querySelector('article');
  if (article) {
    return article.innerHTML;
  }

  // 2. <main>
  const main = root.querySelector('main');
  if (main) {
    return main.innerHTML;
  }

  // 3. h1 + siblings that follow it within the same parent
  const h1 = root.querySelector('h1');
  if (h1) {
    const parts: string[] = [h1.outerHTML];
    let sibling = h1.nextElementSibling;
    while (sibling) {
      parts.push(sibling.outerHTML);
      sibling = sibling.nextElementSibling;
    }
    if (parts.length > 1) {
      return parts.join('\n');
    }
  }

  // 4. <body> fallback
  const body = root.querySelector('body');
  return body ? body.innerHTML : root.innerHTML;
}

async function fetchHtml(url: string): Promise<{ html: string | null; permanentlyDead: boolean; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT },
    });
    if (!response.ok) {
      const status = response.status;
      const permanentlyDead = status >= 400 && status < 500;
      return { html: null, permanentlyDead, status };
    }
    const html = await response.text();
    return { html, permanentlyDead: false };
  } catch (error) {
    return { html: null, permanentlyDead: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process a single listing: fetch, extract, and either fill or expire.
 *
 * Extracted from the `run()` loop so it can be unit-tested with a fake
 * `fetchImpl` without spinning up the full script or hitting the network.
 */
export async function processRow(
  db: Database,
  listing: EmptyListing,
  fetchImpl: FetchImpl,
  now: number,
): Promise<ProcessOutcome> {
  const { html, permanentlyDead, status } = await fetchImpl(listing.apply_url);

  if (permanentlyDead) {
    expireListing(db, listing.id, now);
    console.log(`dead url=${listing.apply_url} status=${status}`);
    return 'expired';
  }

  if (!html) {
    if (status) {
      console.log(`fetch status=${status} url=${listing.apply_url}`);
    }
    return 'error';
  }

  const raw = extractMainContent(html);
  const sanitized = sanitizeHtml(raw);
  const text = stripTags(sanitized).trim();

  if (text.length >= MIN_FILLED_CHARS) {
    db.prepare(`UPDATE listings SET description_html = ? WHERE id = ?`).run(sanitized, listing.id);
    return 'filled';
  }

  expireListing(db, listing.id, now);
  return 'expired';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const db = await openDbWrite(DB_PATH);
  const now = Date.now();

  const emptyListings = db
    .prepare(
      `SELECT id, title, apply_url, company_id
       FROM listings
       WHERE length(description_html) < 50
         AND expires_at > ?
         AND status = 'active'`,
    )
    .all(now) as EmptyListing[];

  let processed = 0;
  let filled = 0;
  let expired = 0;
  let errors = 0;

  for (const listing of emptyListings) {
    if (processed > 0) {
      await sleep(FETCH_DELAY_MS);
    }
    processed += 1;

    const outcome = await processRow(db, listing, fetchHtml, now);
    if (outcome === 'filled') filled += 1;
    else if (outcome === 'expired') expired += 1;
    else errors += 1;
  }

  db.close();
  console.log(`processed=${processed} filled=${filled} expired=${expired} errors=${errors}`);
}

if (import.meta.main) {
  run().catch((error) => {
    console.error('backfill failed:', error);
    process.exit(1);
  });
}
