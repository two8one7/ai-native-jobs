import type { ListingAISpecialty } from '../db/types';
import type { ListingFilters, ListingListRow } from './db';

export const SPECIALTIES: ListingAISpecialty[] = ['nlp', 'vision', 'robotics', 'infra', 'ops'];
export const MIN_COMP_OPTIONS = [50000, 100000, 150000, 200000, 250000] as const;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Extract the disambiguator suffix used in role slugs.
 * Scraped ids: `<ats>:<company>:<external-id>` → first 8 chars of external-id.
 * Paid ids: `lst_xxxxxxx` (no colon) → first 8 chars of full id.
 */
export function getIdSuffix(id: string): string {
  const lastColon = id.lastIndexOf(':');
  const tail = lastColon >= 0 ? id.slice(lastColon + 1) : id;
  return tail.slice(0, 8);
}

export function getRoleSlug(listing: Pick<ListingListRow, 'id' | 'title'>): string {
  return `${slugify(listing.title)}-${getIdSuffix(listing.id)}`;
}

export function getJobPath(listing: Pick<ListingListRow, 'id' | 'title' | 'company_slug'>): string {
  return `/jobs/${listing.company_slug}/${getRoleSlug(listing)}`;
}

export function getCompanyPath(slug: string): string {
  return `/companies/${slug}`;
}

export function formatComp(min: number | null, max: number | null, currency: string | null): string {
  if (min == null && max == null) return 'Comp undisclosed';

  const prefix = currency === 'USD' || currency == null ? '$' : `${currency} `;
  const format = (value: number) => `${prefix}${value.toLocaleString('en-US')}`;

  if (min != null && max != null) return `${format(min)}-${format(max)}`;
  if (min != null) return `${format(min)}+`;
  return `Up to ${format(max!)}`;
}

export function formatPostedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
  }).format(timestamp);
}

export function formatLocation(listing: Pick<ListingListRow, 'location_city' | 'location_country' | 'location_is_remote' | 'location_policy'>): string {
  if (listing.location_is_remote) return 'Remote';
  if (listing.location_city) return `${listing.location_city}, ${listing.location_country}`;
  return listing.location_country || listing.location_policy;
}

export function parseAiStack(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

export function readFilters(searchParams: URLSearchParams): ListingFilters {
  const specialtyValue = searchParams.get('specialty');
  const specialty = SPECIALTIES.includes(specialtyValue as ListingAISpecialty)
    ? (specialtyValue as ListingAISpecialty)
    : null;

  const remoteOnly = searchParams.get('remote') === '1';
  const minCompValue = searchParams.get('min_comp');
  const minComp = minCompValue ? Number(minCompValue) : null;

  return {
    specialty,
    remoteOnly,
    minComp: Number.isFinite(minComp) ? minComp : null,
  };
}

export function buildFilterHref(current: URLSearchParams, next: Partial<ListingFilters>): string {
  const params = new URLSearchParams(current);

  if (Object.prototype.hasOwnProperty.call(next, 'specialty')) {
    if (next.specialty) params.set('specialty', next.specialty);
    else params.delete('specialty');
  }

  if (Object.prototype.hasOwnProperty.call(next, 'remoteOnly')) {
    if (next.remoteOnly) params.set('remote', '1');
    else params.delete('remote');
  }

  if (Object.prototype.hasOwnProperty.call(next, 'minComp')) {
    if (typeof next.minComp === 'number') params.set('min_comp', String(next.minComp));
    else params.delete('min_comp');
  }

  const query = params.toString();
  return query ? `/?${query}` : '/';
}
