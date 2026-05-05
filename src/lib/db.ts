import type { ListingAISpecialty } from '../db/types';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

type StatementLike = {
  all: (...params: Array<number | string>) => unknown[];
  get: (...params: Array<number | string>) => unknown;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  close: () => void;
};

export type ListingListRow = {
  id: string;
  title: string;
  location_city: string | null;
  location_country: string;
  location_is_remote: number;
  location_policy: 'remote' | 'hybrid' | 'onsite';
  comp_min: number | null;
  comp_max: number | null;
  comp_currency: string | null;
  ai_stack: string;
  ai_specialty: ListingAISpecialty | null;
  description_html: string;
  apply_url: string;
  posted_at: number;
  expires_at: number;
  updated_at: number;
  company_slug: string;
  company_name: string;
  company_website: string | null;
  company_description: string | null;
};

export type CompanyRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
};

export type ListingFilters = {
  specialty: ListingAISpecialty | null;
  remoteOnly: boolean;
  minComp: number | null;
};

function getDbPath(): string {
  return process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH;
}

async function openDatabase(): Promise<DatabaseLike> {
  const dbPath = getDbPath();

  if (typeof Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite');
    return new Database(dbPath, { readonly: true, create: false }) as DatabaseLike;
  }

  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { open: true, readOnly: true }) as DatabaseLike;
}

export async function withDb<T>(run: (db: DatabaseLike) => T | Promise<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

function activeListingsWhere(filters?: ListingFilters): { clause: string; params: Array<number | string> } {
  const now = Date.now();
  const clauses = ['l.status = ?', 'l.expires_at > ?'];
  const params: Array<number | string> = ['active', now];

  if (filters?.specialty) {
    clauses.push('l.ai_specialty = ?');
    params.push(filters.specialty);
  }

  if (filters?.remoteOnly) {
    clauses.push('l.location_is_remote = 1');
  }

  if (typeof filters?.minComp === 'number') {
    clauses.push('COALESCE(l.comp_max, l.comp_min, 0) >= ?');
    params.push(filters.minComp);
  }

  return {
    clause: clauses.join(' AND '),
    params,
  };
}

const LISTING_SELECT = `
  SELECT
    l.id,
    l.title,
    l.location_city,
    l.location_country,
    l.location_is_remote,
    l.location_policy,
    l.comp_min,
    l.comp_max,
    l.comp_currency,
    l.ai_stack,
    l.ai_specialty,
    l.description_html,
    l.apply_url,
    l.posted_at,
    l.expires_at,
    l.updated_at,
    c.slug AS company_slug,
    c.name AS company_name,
    c.website AS company_website,
    c.description AS company_description
  FROM listings l
  INNER JOIN companies c ON c.id = l.company_id
`;

export async function getRecentListings(filters: ListingFilters, limit = 50): Promise<ListingListRow[]> {
  return withDb(async (db) => {
    const { clause, params } = activeListingsWhere(filters);
    return db
      .prepare(
        `${LISTING_SELECT}
         WHERE ${clause}
         ORDER BY l.posted_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as ListingListRow[];
  });
}

export async function getAllActiveListings(): Promise<ListingListRow[]> {
  return withDb(async (db) => {
    const { clause, params } = activeListingsWhere();
    return db
      .prepare(
        `${LISTING_SELECT}
         WHERE ${clause}
         ORDER BY l.posted_at DESC`
      )
      .all(...params) as ListingListRow[];
  });
}

export async function getAllCompanies(): Promise<CompanyRow[]> {
  return withDb(async (db) =>
    db
      .prepare(
        `SELECT id, slug, name, description
         FROM companies
         ORDER BY name ASC`
      )
      .all() as CompanyRow[]
  );
}

export async function getCompanyBySlug(slug: string): Promise<CompanyRow | null> {
  return withDb(async (db) =>
    (db
      .prepare(
        `SELECT id, slug, name, description
         FROM companies
         WHERE slug = ?`
      )
      .get(slug) as CompanyRow | null) ?? null
  );
}

export async function getActiveListingsForCompany(companyId: string): Promise<ListingListRow[]> {
  return withDb(async (db) => {
    const { clause, params } = activeListingsWhere();
    return db
      .prepare(
        `${LISTING_SELECT}
         WHERE ${clause} AND l.company_id = ?
         ORDER BY l.posted_at DESC`
      )
      .all(...params, companyId) as ListingListRow[];
  });
}

/**
 * Look up a single active listing by company slug + role slug. Role slug shape:
 * `${slugify(title)}-${id.slice(0, 8)}` (see lib/jobs.ts getRoleSlug). The 8-char
 * id prefix is a near-collision-free key once company is also constrained.
 */
export async function getListingBySlugs(
  companySlug: string,
  roleSlug: string,
): Promise<ListingListRow | null> {
  // Strip the trailing `-<idPrefix>` from the role slug. id is `lst_xxxx...`,
  // so the prefix contains an underscore but no further hyphens.
  const dashIdx = roleSlug.lastIndexOf('-');
  if (dashIdx <= 0 || dashIdx === roleSlug.length - 1) return null;
  const idPrefix = roleSlug.slice(dashIdx + 1);
  if (!/^[a-z0-9_]{4,}$/i.test(idPrefix)) return null;

  return withDb(async (db) => {
    const { clause, params } = activeListingsWhere();
    return (db
      .prepare(
        `${LISTING_SELECT}
         WHERE ${clause} AND c.slug = ? AND l.id LIKE ?
         LIMIT 1`,
      )
      .get(...params, companySlug, `${idPrefix}%`) as ListingListRow | null) ?? null;
  });
}

/**
 * Look up the listing fulfilled for a Stripe checkout session.
 * Used for the post-checkout redirect from `/post?ok=1&session_id=...`.
 */
export async function getListingByStripeSessionId(
  stripeSessionId: string,
): Promise<ListingListRow | null> {
  return withDb(async (db) => {
    const { clause, params } = activeListingsWhere();
    return (db
      .prepare(
        `${LISTING_SELECT}
         INNER JOIN paid_listings p ON p.listing_id = l.id
         WHERE ${clause} AND p.stripe_session_id = ?
         LIMIT 1`,
      )
      .get(...params, stripeSessionId) as ListingListRow | null) ?? null;
  });
}
