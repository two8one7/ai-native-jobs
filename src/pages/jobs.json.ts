import type { APIRoute } from 'astro';
import { getAllActiveListings } from '../lib/db';

const PAGE_SIZE = 50;
const PAGINATION_THRESHOLD = 1000;

export const prerender = false;

function toPositiveInteger(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export const GET: APIRoute = async ({ url }) => {
  const listings = await getAllActiveListings();
  const total = listings.length;
  const page = toPositiveInteger(url.searchParams.get('page'));

  const payload = total > PAGINATION_THRESHOLD ? listings.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : listings;

  return new Response(JSON.stringify(payload), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
};
