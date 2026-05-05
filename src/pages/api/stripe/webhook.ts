import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { decodeDraftFromMetadata, getStripe, priceForTier, type Tier } from '../../../lib/stripe';
import { withDbWrite } from '../../../lib/db-write';
import { fulfillPaidListing } from '../../../lib/stripe-fulfill';

export const prerender = false;

function bad(message: string, status = 400): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET is not set');
    return bad('webhook secret not configured', 500);
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) return bad('missing stripe-signature header');

  // Raw bytes — signature verify must run against the unparsed body.
  const rawBody = await request.text();

  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    console.error('[stripe/webhook] stripe init failed:', err);
    return bad('stripe not configured', 500);
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
  } catch (err) {
    console.warn('[stripe/webhook] signature verify failed:', err);
    return bad('invalid signature');
  }

  if (event.type !== 'checkout.session.completed') {
    // Acknowledge events we don't act on so Stripe doesn't keep retrying.
    return new Response('ignored', { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const meta = (session.metadata ?? {}) as Record<string, string | undefined>;

  let draft;
  try {
    draft = decodeDraftFromMetadata(meta);
  } catch (err) {
    console.error('[stripe/webhook] could not decode draft metadata:', err);
    return bad('invalid session metadata', 400);
  }

  const tierRaw = meta.tier;
  const tier: Tier = tierRaw === 'founding' || tierRaw === 'standard' ? tierRaw : 'standard';
  const amountCents = session.amount_total ?? Number(meta.amount_cents ?? priceForTier(tier));
  const currency = session.currency ?? 'usd';

  try {
    const result = await withDbWrite((db) =>
      fulfillPaidListing(db, {
        draft,
        tier,
        amountCents,
        currency,
        sessionId: session.id,
        eventId: event.id,
        paidAt: Date.now(),
      }),
    );
    return new Response(result === 'duplicate' ? 'duplicate' : 'ok', { status: 200 });
  } catch (err) {
    // SQLite UNIQUE conflict on stripe_event_id is also idempotency — return 200 instead of 500.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed.*stripe_event_id|UNIQUE constraint failed.*stripe_session_id/i.test(message)) {
      return new Response('duplicate', { status: 200 });
    }
    console.error('[stripe/webhook] fulfill failed:', err);
    return bad('fulfill failed', 500);
  }
};
