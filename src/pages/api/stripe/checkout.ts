import type { APIRoute } from 'astro';
import {
  FOUNDING_TIER_LIMIT,
  LOCATION_POLICIES,
  SPECIALTIES,
  encodeDraftToMetadata,
  getStripe,
  isAllowedAtsUrl,
  priceForTier,
  type ListingDraft,
  type Tier,
} from '../../../lib/stripe';
import { withDbWrite } from '../../../lib/db-write';
import type { ListingAISpecialty, ListingLocationPolicy } from '../../../db/types';

export const prerender = false;

const SITE_URL = process.env.PUBLIC_SITE_URL ?? 'https://ai-native-jobs.tommyato.com';

function bad(message: string): Response {
  // Redirect back to the form with the error surfaced; non-JS forms get readable feedback this way.
  const target = `/post?error=${encodeURIComponent(message)}`;
  return new Response(null, { status: 303, headers: { Location: target } });
}

function trim(value: FormDataEntryValue | null, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function optionalTrim(value: FormDataEntryValue | null, maxLen: number): string | null {
  const t = trim(value, maxLen);
  return t.length === 0 ? null : t;
}

function optionalInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? n : null;
}

function parseStack(raw: string): string[] {
  return raw
    .split(/[,\n]/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 40)
    .slice(0, 24);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function descriptionToHtml(plain: string): string {
  // Conservative: split paragraphs on blank lines, escape, wrap. Sanitizer-safe.
  const paragraphs = plain
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return '<p></p>';
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

async function paidListingCount(): Promise<number> {
  try {
    return await withDbWrite((db) => {
      const row = db.prepare('SELECT COUNT(*) as count FROM paid_listings').get() as { count: number } | undefined;
      return row?.count ?? 0;
    });
  } catch {
    return 0;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();

  const company_name = trim(form.get('company_name'), 120);
  const company_website = trim(form.get('company_website'), 240);
  const customer_email = trim(form.get('customer_email'), 240);
  const title = trim(form.get('title'), 160);
  const apply_url = trim(form.get('apply_url'), 480);
  const description = trim(form.get('description'), 6000);
  const location_country = trim(form.get('location_country'), 60);
  const location_policyRaw = trim(form.get('location_policy'), 12);
  const ai_specialtyRaw = trim(form.get('ai_specialty'), 12);
  const ai_stackRaw = trim(form.get('ai_stack'), 240);

  if (!company_name || !company_website || !customer_email || !title || !apply_url || !description || !location_country) {
    return bad('Please fill in every required field.');
  }
  if (!/^https?:\/\//i.test(company_website)) {
    return bad('Company website must start with http(s)://.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer_email)) {
    return bad('Billing email looks invalid.');
  }
  if (!isAllowedAtsUrl(apply_url)) {
    return bad('Apply URL must be on lever.co, *.greenhouse.io, boards.greenhouse.io, or jobs.ashbyhq.com.');
  }
  if (!(LOCATION_POLICIES as readonly string[]).includes(location_policyRaw)) {
    return bad('Pick a valid location policy.');
  }
  let ai_specialty: ListingAISpecialty | null = null;
  if (ai_specialtyRaw) {
    if (!(SPECIALTIES as readonly string[]).includes(ai_specialtyRaw)) {
      return bad('Pick a valid AI specialty.');
    }
    ai_specialty = ai_specialtyRaw as ListingAISpecialty;
  }
  const location_policy = location_policyRaw as ListingLocationPolicy;
  const location_is_remote: 0 | 1 = location_policy === 'onsite' ? 0 : 1;

  const draft: ListingDraft = {
    company_name,
    company_website,
    title,
    apply_url,
    description_html: descriptionToHtml(description),
    location_city: optionalTrim(form.get('location_city'), 80),
    location_country,
    location_is_remote,
    location_policy,
    comp_min: optionalInt(form.get('comp_min')),
    comp_max: optionalInt(form.get('comp_max')),
    comp_currency: optionalTrim(form.get('comp_currency'), 6),
    ai_specialty,
    ai_stack: parseStack(ai_stackRaw),
    customer_email,
  };

  const sold = await paidListingCount();
  const tier: Tier = sold < FOUNDING_TIER_LIMIT ? 'founding' : 'standard';
  const amountCents = priceForTier(tier);

  const productName =
    tier === 'founding' ? 'AI Native Jobs · Founding listing (30 days)' : 'AI Native Jobs · Listing (30 days)';
  const productDescription = `${title} at ${company_name}`.slice(0, 240);

  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    console.error('[stripe/checkout] stripe init failed:', err);
    return bad('Checkout is temporarily unavailable. Please try again shortly.');
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email,
      success_url: `${SITE_URL}/post?ok=1`,
      cancel_url: `${SITE_URL}/post?error=${encodeURIComponent('Checkout cancelled.')}`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: productName,
              description: productDescription,
            },
          },
        },
      ],
      metadata: {
        ...encodeDraftToMetadata(draft),
        tier,
        amount_cents: String(amountCents),
      },
    });
  } catch (err) {
    console.error('[stripe/checkout] create session failed:', err);
    return bad('Could not start checkout. Please try again.');
  }

  if (!session.url) {
    return bad('Checkout session has no redirect URL.');
  }

  return new Response(null, { status: 303, headers: { Location: session.url } });
};
