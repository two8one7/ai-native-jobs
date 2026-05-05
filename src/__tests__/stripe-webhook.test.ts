import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { encodeDraftToMetadata, type ListingDraft } from '../lib/stripe';
import { fulfillPaidListing } from '../lib/stripe-fulfill';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

const FAKE_SECRET = 'whsec_test_secret_for_unit_tests_only';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return db;
}

function makeDraft(overrides: Partial<ListingDraft> = {}): ListingDraft {
  return {
    company_name: 'Test Inference Co',
    company_website: 'https://test-inference.example',
    title: 'Senior Inference Engineer',
    apply_url: 'https://jobs.ashbyhq.com/test-inference/abc-123',
    description_html: '<p>Build the inference stack.</p>',
    location_city: 'San Francisco',
    location_country: 'US',
    location_is_remote: 1,
    location_policy: 'hybrid',
    comp_min: 200_000,
    comp_max: 280_000,
    comp_currency: 'USD',
    ai_specialty: 'infra',
    ai_stack: ['pytorch', 'cuda', 'vllm'],
    customer_email: 'employer@test-inference.example',
    ...overrides,
  };
}

function makeCompletedEvent(opts: {
  draft: ListingDraft;
  tier: 'founding' | 'standard';
  eventId: string;
  sessionId: string;
}): { rawBody: string; eventId: string; sessionId: string } {
  const event = {
    id: opts.eventId,
    object: 'event' as const,
    api_version: '2026-04-22.dahlia',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed' as const,
    livemode: true,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: opts.sessionId,
        object: 'checkout.session',
        amount_total: opts.tier === 'founding' ? 19900 : 29900,
        currency: 'usd',
        customer_email: opts.draft.customer_email,
        metadata: {
          ...encodeDraftToMetadata(opts.draft),
          tier: opts.tier,
          amount_cents: String(opts.tier === 'founding' ? 19900 : 29900),
        },
        payment_status: 'paid',
        status: 'complete',
      },
    },
  };
  return {
    rawBody: JSON.stringify(event),
    eventId: opts.eventId,
    sessionId: opts.sessionId,
  };
}

function makeStripe(): Stripe {
  return new Stripe('sk_test_fake_for_unit_tests', { apiVersion: '2026-04-22.dahlia' });
}

async function signedHeader(stripe: Stripe, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return stripe.webhooks.generateTestHeaderStringAsync({
    payload: rawBody,
    secret: FAKE_SECRET,
    timestamp,
  });
}

describe('Stripe webhook signature verification', () => {
  test('rejects events with a bad signature', async () => {
    const stripe = makeStripe();
    const { rawBody } = makeCompletedEvent({
      draft: makeDraft(),
      tier: 'founding',
      eventId: 'evt_bad_sig_1',
      sessionId: 'cs_bad_sig_1',
    });

    let threw = false;
    try {
      await stripe.webhooks.constructEventAsync(rawBody, 'not-a-real-sig', FAKE_SECRET);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('accepts events signed with the matching secret', async () => {
    const stripe = makeStripe();
    const { rawBody, eventId } = makeCompletedEvent({
      draft: makeDraft(),
      tier: 'founding',
      eventId: 'evt_good_sig_1',
      sessionId: 'cs_good_sig_1',
    });
    const header = await signedHeader(stripe, rawBody);

    const event = await stripe.webhooks.constructEventAsync(rawBody, header, FAKE_SECRET);
    expect(event.id).toBe(eventId);
    expect(event.type).toBe('checkout.session.completed');
  });
});

describe('fulfillPaidListing', () => {
  test('inserts a listing + paid_listings row on first delivery', () => {
    const db = makeDb();
    const draft = makeDraft();

    const result = fulfillPaidListing(db, {
      draft,
      tier: 'founding',
      amountCents: 19900,
      currency: 'usd',
      sessionId: 'cs_1',
      eventId: 'evt_1',
      paidAt: Date.now(),
    });
    expect(result).toBe('inserted');

    const listingCount = db.query('SELECT COUNT(*) as c FROM listings').get() as { c: number };
    const paidCount = db.query('SELECT COUNT(*) as c FROM paid_listings').get() as { c: number };
    const companyCount = db.query('SELECT COUNT(*) as c FROM companies').get() as { c: number };
    expect(listingCount.c).toBe(1);
    expect(paidCount.c).toBe(1);
    expect(companyCount.c).toBe(1);

    const listingRow = db
      .query("SELECT title, status, ai_stack FROM listings LIMIT 1")
      .get() as { title: string; status: string; ai_stack: string };
    expect(listingRow.title).toBe(draft.title);
    expect(listingRow.status).toBe('active');
    expect(JSON.parse(listingRow.ai_stack)).toEqual(draft.ai_stack);

    const paidRow = db
      .query('SELECT tier, amount_cents, customer_email, stripe_event_id FROM paid_listings LIMIT 1')
      .get() as { tier: string; amount_cents: number; customer_email: string; stripe_event_id: string };
    expect(paidRow.tier).toBe('founding');
    expect(paidRow.amount_cents).toBe(19900);
    expect(paidRow.customer_email).toBe(draft.customer_email);
    expect(paidRow.stripe_event_id).toBe('evt_1');

    db.close();
  });

  test('replaying the same event id is a no-op (idempotent)', () => {
    const db = makeDb();
    const draft = makeDraft();

    const first = fulfillPaidListing(db, {
      draft,
      tier: 'founding',
      amountCents: 19900,
      currency: 'usd',
      sessionId: 'cs_replay',
      eventId: 'evt_replay',
      paidAt: Date.now(),
    });
    const second = fulfillPaidListing(db, {
      draft,
      tier: 'founding',
      amountCents: 19900,
      currency: 'usd',
      sessionId: 'cs_replay',
      eventId: 'evt_replay',
      paidAt: Date.now(),
    });

    expect(first).toBe('inserted');
    expect(second).toBe('duplicate');

    const listingCount = db.query('SELECT COUNT(*) as c FROM listings').get() as { c: number };
    const paidCount = db.query('SELECT COUNT(*) as c FROM paid_listings').get() as { c: number };
    expect(listingCount.c).toBe(1);
    expect(paidCount.c).toBe(1);

    db.close();
  });

  test('reuses an existing company when website matches', () => {
    const db = makeDb();
    const draft1 = makeDraft({ title: 'Engineer A' });
    const draft2 = makeDraft({ title: 'Engineer B' });

    fulfillPaidListing(db, {
      draft: draft1,
      tier: 'founding',
      amountCents: 19900,
      currency: 'usd',
      sessionId: 'cs_a',
      eventId: 'evt_a',
      paidAt: Date.now(),
    });
    fulfillPaidListing(db, {
      draft: draft2,
      tier: 'founding',
      amountCents: 19900,
      currency: 'usd',
      sessionId: 'cs_b',
      eventId: 'evt_b',
      paidAt: Date.now(),
    });

    const companyCount = db.query('SELECT COUNT(*) as c FROM companies').get() as { c: number };
    const listingCount = db.query('SELECT COUNT(*) as c FROM listings').get() as { c: number };
    expect(companyCount.c).toBe(1);
    expect(listingCount.c).toBe(2);

    db.close();
  });
});
