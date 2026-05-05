import Stripe from 'stripe';
import type { ListingAISpecialty, ListingLocationPolicy } from '../db/types';

/**
 * Stripe wiring for ai-native-jobs.
 *
 * Live keys from day one — no test/live toggle, no launch flag.
 * The constants below are the contract between `/api/stripe/checkout`
 * and `/api/stripe/webhook`; both must agree on shape and chunk size.
 */

export const FOUNDING_PRICE_CENTS = 19900; // $199 first 50
export const STANDARD_PRICE_CENTS = 29900; // $299 thereafter
export const FOUNDING_TIER_LIMIT = 50;
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const ALLOWED_ATS_HOSTS = [
  'lever.co',
  'boards.greenhouse.io',
  'jobs.ashbyhq.com',
] as const;
export const ALLOWED_ATS_HOST_SUFFIXES = ['.greenhouse.io'] as const;

export const SPECIALTIES: readonly ListingAISpecialty[] = ['nlp', 'vision', 'robotics', 'infra', 'ops'];
export const LOCATION_POLICIES: readonly ListingLocationPolicy[] = ['remote', 'hybrid', 'onsite'];

/** The serialized listing draft we hand to Stripe in metadata and read back from the webhook. */
export type ListingDraft = {
  company_name: string;
  company_website: string;
  title: string;
  apply_url: string;
  description_html: string;
  location_city: string | null;
  location_country: string;
  location_is_remote: 0 | 1;
  location_policy: ListingLocationPolicy;
  comp_min: number | null;
  comp_max: number | null;
  comp_currency: string | null;
  ai_specialty: ListingAISpecialty | null;
  ai_stack: string[];
  customer_email: string;
};

export type Tier = 'founding' | 'standard';

let cachedClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_LIVE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_LIVE_SECRET_KEY is not set');
  }
  cachedClient = new Stripe(key);
  return cachedClient;
}

/** Validate that an apply URL points at one of the allowed ATS hosts. */
export function isAllowedAtsUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if ((ALLOWED_ATS_HOSTS as readonly string[]).includes(host)) return true;
  return ALLOWED_ATS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const META_CHUNK = 450; // Stripe limit is 500 chars per value; leave headroom.
const META_PREFIX = 'd';

/** Split a JSON-stringified listing draft into Stripe metadata chunks. */
export function encodeDraftToMetadata(draft: ListingDraft): Record<string, string> {
  const json = JSON.stringify(draft);
  const out: Record<string, string> = {};
  let idx = 0;
  for (let offset = 0; offset < json.length; offset += META_CHUNK) {
    out[`${META_PREFIX}${idx}`] = json.slice(offset, offset + META_CHUNK);
    idx += 1;
  }
  out.draft_chunks = String(idx);
  return out;
}

/** Reassemble a listing draft from Stripe session metadata. */
export function decodeDraftFromMetadata(meta: Record<string, string | undefined> | null): ListingDraft {
  if (!meta) throw new Error('missing checkout session metadata');
  const totalRaw = meta.draft_chunks;
  const total = totalRaw ? Number.parseInt(totalRaw, 10) : NaN;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('checkout session metadata missing draft_chunks');
  }
  let json = '';
  for (let i = 0; i < total; i += 1) {
    const part = meta[`${META_PREFIX}${i}`];
    if (typeof part !== 'string') {
      throw new Error(`checkout session metadata missing chunk ${i}`);
    }
    json += part;
  }
  const parsed = JSON.parse(json) as unknown;
  return assertListingDraftShape(parsed);
}

function assertListingDraftShape(value: unknown): ListingDraft {
  if (!value || typeof value !== 'object') throw new Error('decoded draft is not an object');
  const v = value as Record<string, unknown>;
  const requiredString = (key: string): string => {
    const x = v[key];
    if (typeof x !== 'string' || x.length === 0) {
      throw new Error(`draft.${key} must be a non-empty string`);
    }
    return x;
  };
  const optionalString = (key: string): string | null => {
    const x = v[key];
    if (x === null || x === undefined || x === '') return null;
    if (typeof x !== 'string') throw new Error(`draft.${key} must be a string or null`);
    return x;
  };
  const optionalNumber = (key: string): number | null => {
    const x = v[key];
    if (x === null || x === undefined) return null;
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    throw new Error(`draft.${key} must be a finite number or null`);
  };
  const policy = requiredString('location_policy');
  if (!(LOCATION_POLICIES as readonly string[]).includes(policy)) {
    throw new Error(`draft.location_policy invalid: ${policy}`);
  }
  const isRemote = v.location_is_remote;
  if (isRemote !== 0 && isRemote !== 1) {
    throw new Error('draft.location_is_remote must be 0 or 1');
  }
  const stackRaw = v.ai_stack;
  if (!Array.isArray(stackRaw) || !stackRaw.every((s) => typeof s === 'string')) {
    throw new Error('draft.ai_stack must be a string[]');
  }
  const specialtyRaw = v.ai_specialty;
  let specialty: ListingAISpecialty | null = null;
  if (specialtyRaw !== null && specialtyRaw !== undefined) {
    if (typeof specialtyRaw !== 'string' || !(SPECIALTIES as readonly string[]).includes(specialtyRaw)) {
      throw new Error(`draft.ai_specialty invalid: ${String(specialtyRaw)}`);
    }
    specialty = specialtyRaw as ListingAISpecialty;
  }
  return {
    company_name: requiredString('company_name'),
    company_website: requiredString('company_website'),
    title: requiredString('title'),
    apply_url: requiredString('apply_url'),
    description_html: requiredString('description_html'),
    location_city: optionalString('location_city'),
    location_country: requiredString('location_country'),
    location_is_remote: isRemote as 0 | 1,
    location_policy: policy as ListingLocationPolicy,
    comp_min: optionalNumber('comp_min'),
    comp_max: optionalNumber('comp_max'),
    comp_currency: optionalString('comp_currency'),
    ai_specialty: specialty,
    ai_stack: stackRaw,
    customer_email: requiredString('customer_email'),
  };
}

export function priceForTier(tier: Tier): number {
  return tier === 'founding' ? FOUNDING_PRICE_CENTS : STANDARD_PRICE_CENTS;
}
