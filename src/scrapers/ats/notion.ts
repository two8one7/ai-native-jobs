import type { RawJob } from './types';

// ─── Notion record-map types ──────────────────────────────────────────────────
//
// Notion's public-page data comes in two shapes depending on the page age and
// host:
//
//   Legacy (notion.so SSR + __NEXT_DATA__):
//     blockMap[id] = { role, value: { id, type, properties, ... } }
//
//   Modern (*.notion.site SPA + /api/v3/loadPageChunk):
//     blockMap[id] = { spaceId, value: { value: { id, type, properties, ... } } }
//
// `unwrapBlockValue` collapses both into the same shape so the rest of the
// extractor stays format-agnostic.

type NotionTitleSegment = [string, ...unknown[]];

type NotionBlockValue = {
  id: string;
  type: string;
  properties?: {
    title?: NotionTitleSegment[];
    [key: string]: unknown;
  };
  last_edited_time?: number | null;
  parent_id?: string | null;
  parent_table?: string | null;
  content?: string[] | null;
  collection_id?: string | null;
  view_ids?: string[] | null;
  space_id?: string | null;
};

type NotionBlock = {
  role?: string;
  spaceId?: string;
  value?: unknown;
};

type NotionRecordMap = {
  block?: Record<string, NotionBlock>;
  [key: string]: unknown;
};

type NotionNextData = {
  props?: {
    pageProps?: {
      recordMap?: NotionRecordMap;
    };
  };
};

type CollectionViewRef = {
  blockId: string;
  collectionId: string;
  viewId: string;
  spaceId: string | null;
};

// API response shapes (subset).
type LoadPageChunkResponse = { recordMap?: NotionRecordMap };
type QueryCollectionResponse = { recordMap?: NotionRecordMap };

// ─── URL + slug helpers ───────────────────────────────────────────────────────

// Build the page URL from a slug.
//
// Slug formats produced by detect.ts:
//   "workspace:page-id"  →  https://www.notion.so/workspace/page-id
//   "<path-with-32hex>"  →  https://www.notion.so/<path>          (notion.site path slug)
//   "<path>"             →  https://www.notion.so/<path>          (last-resort fallback)
function buildUrl(slug: string): string {
  const colonIdx = slug.indexOf(':');
  if (colonIdx !== -1) {
    const workspace = slug.slice(0, colonIdx);
    const pagePath = slug.slice(colonIdx + 1);
    return `https://www.notion.so/${workspace}/${pagePath}`;
  }

  return `https://www.notion.so/${slug}`;
}

// Strip UUID dashes and take the first 8 hex characters as a short stable ID.
function shortId(blockId: string): string {
  return blockId.replace(/-/g, '').slice(0, 8);
}

// Normalize a raw page id (with or without dashes) to canonical dashed form.
// Returns null if the input doesn't contain a valid 32-hex page id.
function normalizePageId(raw: string): string | null {
  const trimmed = raw.trim();
  const dashed = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const bare = /^[a-f0-9]{32}$/i;

  if (dashed.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (bare.test(trimmed)) {
    const hex = trimmed.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return null;
}

// Extract a Notion page id from a slug — handles both notion.so workspace:uuid
// and notion.site path slugs (which always end in a 32-hex page id).
function extractPageIdFromSlug(slug: string): string | null {
  // workspace:uuid form
  const colonIdx = slug.indexOf(':');
  if (colonIdx !== -1) {
    const tail = slug.slice(colonIdx + 1);
    const direct = normalizePageId(tail);
    if (direct) return direct;
  }

  // Path slug ending in a 32-hex group, e.g. "Careers-at-Diligent-2176507c..."
  // The id may be the full slug, or appear after the last "-".
  const tailHex = slug.match(/([a-f0-9]{32})(?:[/?#-]|$)/i);
  if (tailHex) {
    return normalizePageId(tailHex[1]);
  }

  // Try the entire slug as a candidate (rare but covers bare-id slugs).
  const direct = normalizePageId(slug);
  if (direct) return direct;

  return null;
}

// Extract the pageId baked into a *.notion.site SPA shell.
//
// The shell contains:
//   __notion_html_async.push("requiredRedirectMetadata",{"pageId":"<uuid>","requiresRedirect":false})
function extractPageIdFromHtml(html: string): string | null {
  const match = html.match(/"pageId"\s*:\s*"([a-f0-9-]{32,36})"/i);
  if (!match) return null;
  return normalizePageId(match[1]);
}

// ─── Block-value normalization ────────────────────────────────────────────────

// Collapse legacy ({ value: { ... } }) and modern ({ value: { value: { ... } } })
// block shapes into a single NotionBlockValue.
function unwrapBlockValue(block: unknown): NotionBlockValue | null {
  if (!block || typeof block !== 'object') return null;
  const v = (block as { value?: unknown }).value;
  if (!v || typeof v !== 'object') return null;

  // Modern double-wrap: value.value is the actual block value.
  const inner = (v as { value?: unknown }).value;
  if (inner && typeof inner === 'object' && 'type' in inner) {
    return inner as NotionBlockValue;
  }

  // Legacy single-wrap: value is the block value.
  if ('type' in (v as object)) {
    return v as NotionBlockValue;
  }
  return null;
}

// Extract a plain string from Notion's rich-text title format: [["Text", ...], ...].
function extractTitle(titleProp: NotionTitleSegment[] | undefined | null): string | null {
  if (!Array.isArray(titleProp) || titleProp.length === 0) {
    return null;
  }

  // Concatenate all string segments — titles may be split across multiple
  // rich-text runs (e.g. styled fragments).
  const parts: string[] = [];
  for (const segment of titleProp) {
    if (Array.isArray(segment) && typeof segment[0] === 'string') {
      parts.push(segment[0]);
    }
  }

  const joined = parts.join('').trim();
  return joined.length > 0 ? joined : null;
}

// ─── Job extraction ───────────────────────────────────────────────────────────

// Walk a block map and collect all page blocks whose parent is a collection
// (the "rows" of a Notion database — i.e. job listings).
function extractJobsFromRecordMap(
  blockMap: Record<string, NotionBlock> | undefined,
): RawJob[] {
  if (!blockMap) return [];

  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  for (const [blockId, block] of Object.entries(blockMap)) {
    const val = unwrapBlockValue(block);
    if (!val || val.type !== 'page' || val.parent_table !== 'collection') {
      continue;
    }

    const title = extractTitle(val.properties?.title);
    if (!title) continue;

    if (seen.has(blockId)) continue;
    seen.add(blockId);

    const idNoDashes = blockId.replace(/-/g, '');
    const applyUrl = `https://www.notion.so/${idNoDashes}`;

    jobs.push({
      provider: 'notion',
      providerJobId: shortId(blockId),
      title,
      location: null,
      description: '',
      applyUrl,
      // last_edited_time is a Unix ms timestamp; convert to ISO for the normalizer.
      postedAt:
        typeof val.last_edited_time === 'number'
          ? new Date(val.last_edited_time).toISOString()
          : null,
    });
  }

  return jobs;
}

// Find every collection_view / collection_view_page block in a record map.
// These reference a child collection that must be loaded via /api/v3/queryCollection.
function findCollectionViews(
  blockMap: Record<string, NotionBlock> | undefined,
): CollectionViewRef[] {
  if (!blockMap) return [];

  const refs: CollectionViewRef[] = [];
  for (const [blockId, block] of Object.entries(blockMap)) {
    const val = unwrapBlockValue(block);
    if (!val) continue;
    if (val.type !== 'collection_view' && val.type !== 'collection_view_page') {
      continue;
    }
    const collectionId = val.collection_id;
    const viewIds = val.view_ids;
    if (!collectionId || !Array.isArray(viewIds) || viewIds.length === 0) {
      continue;
    }

    const spaceId =
      val.space_id ??
      (block as NotionBlock).spaceId ??
      null;

    refs.push({
      blockId,
      collectionId,
      viewId: viewIds[0],
      spaceId,
    });
  }
  return refs;
}

// ─── Legacy parser (notion.so SSR + __NEXT_DATA__) ───────────────────────────

function parseNextData(html: string): RawJob[] {
  const scriptMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!scriptMatch) return [];

  let data: NotionNextData;
  try {
    data = JSON.parse(scriptMatch[1]) as NotionNextData;
  } catch {
    return [];
  }

  const blockMap = data?.props?.pageProps?.recordMap?.block;
  return extractJobsFromRecordMap(blockMap);
}

// Fallback: DOM parse for .notion-collection-row anchors.
function parseDomFallback(html: string): RawJob[] {
  const jobs: RawJob[] = [];

  const rowRegex =
    /<div[^>]+class="[^"]*notion-collection-row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)/gi;
  const linkRegex = /href="([^"]+)"[^>]*>([^<]+)</i;
  const pageIdRegex = /([a-f0-9]{32})(?:[/?#]|$)/i;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const linkMatch = rowHtml.match(linkRegex);
    if (!linkMatch) continue;

    const href = linkMatch[1].trim();
    const title = linkMatch[2].trim();
    if (!title) continue;

    const idMatch = href.replace(/-/g, '').match(pageIdRegex);
    if (!idMatch) continue;

    const blockId = idMatch[1];
    jobs.push({
      provider: 'notion',
      providerJobId: blockId.slice(0, 8),
      title,
      location: null,
      description: '',
      applyUrl: href.startsWith('http') ? href : `https://www.notion.so${href}`,
      postedAt: null,
    });
  }

  return jobs;
}

// ─── Modern API parser (*.notion.site SPA) ───────────────────────────────────
//
// Modern *.notion.site pages serve only a JS bundle shell — no rendered content
// in the initial HTML. We extract the pageId, then call:
//
//   POST https://www.notion.so/api/v3/loadPageChunk
//     → page block tree (may include inline collection rows for legacy Diligent-style pages)
//
//   POST https://www.notion.so/api/v3/queryCollection (per collection_view found in chunk)
//     → the actual rows of that collection (Notion-database listings)
//
// www.notion.so is the canonical API host — works for any public page regardless
// of which workspace subdomain it lives under.

const NOTION_API_HOST = 'https://www.notion.so';
const NOTION_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': NOTION_USER_AGENT,
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function loadPageChunk(pageId: string): Promise<LoadPageChunkResponse | null> {
  return postJson<LoadPageChunkResponse>(`${NOTION_API_HOST}/api/v3/loadPageChunk`, {
    pageId,
    limit: 100,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false,
  });
}

async function queryCollection(
  ref: CollectionViewRef,
): Promise<QueryCollectionResponse | null> {
  // The modern (post-2023) queryCollection signature requires `source` +
  // `collectionView` with spaceId. spaceId is omitted when unknown — Notion
  // accepts that for fully-public pages.
  const body: Record<string, unknown> = {
    source: { type: 'collection', id: ref.collectionId },
    collectionView: { id: ref.viewId },
    loader: {
      reducers: {
        collection_group_results: { type: 'results', limit: 100 },
      },
      searchQuery: '',
      userTimeZone: 'Etc/UTC',
    },
  };
  if (ref.spaceId) {
    (body.source as Record<string, unknown>).spaceId = ref.spaceId;
    (body.collectionView as Record<string, unknown>).spaceId = ref.spaceId;
  }

  return postJson<QueryCollectionResponse>(
    `${NOTION_API_HOST}/api/v3/queryCollection?src=initial_load`,
    body,
  );
}

async function fetchJobsViaApi(pageId: string): Promise<RawJob[]> {
  const chunk = await loadPageChunk(pageId);
  if (!chunk?.recordMap?.block) return [];

  const blockMap = chunk.recordMap.block;
  const inline = extractJobsFromRecordMap(blockMap);
  const refs = findCollectionViews(blockMap);

  const fromCollections: RawJob[] = [];
  for (const ref of refs) {
    const coll = await queryCollection(ref);
    if (!coll?.recordMap?.block) continue;
    fromCollections.push(...extractJobsFromRecordMap(coll.recordMap.block));
  }

  // Dedupe by providerJobId (8-char short id) — collection rows can appear
  // both inline in the page chunk and again in queryCollection results.
  const seen = new Set<string>();
  const merged: RawJob[] = [];
  for (const job of [...inline, ...fromCollections]) {
    if (seen.has(job.providerJobId)) continue;
    seen.add(job.providerJobId);
    merged.push(job);
  }
  return merged;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function fetchNotion(slug: string): Promise<RawJob[]> {
  const url = buildUrl(slug);

  // Chrome UA — Googlebot 403s (reverse-DNS validation); Bingbot also 403s on
  // notion.so workspace pages. Chrome passes both *.notion.site and notion.so.
  // (Fixes #13.)
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'user-agent': NOTION_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Notion fetch failed for ${slug}: ${response.status}`);
  }

  const html = await response.text();

  // Path 1: legacy notion.so SSR pages with __NEXT_DATA__.
  const legacyJobs = parseNextData(html);
  if (legacyJobs.length > 0) return legacyJobs;

  // Path 2: rendered DOM collection rows (older fully-rendered exports).
  const domJobs = parseDomFallback(html);
  if (domJobs.length > 0) return domJobs;

  // Path 3: modern *.notion.site SPA — extract pageId and hit the public API.
  // pageId can come from the SPA shell's requiredRedirectMetadata, or be parsed
  // out of the slug directly (which always carries a trailing 32-hex group).
  const pageId = extractPageIdFromHtml(html) ?? extractPageIdFromSlug(slug);
  if (!pageId) return [];

  return await fetchJobsViaApi(pageId);
}

// Exported for testing
export {
  buildUrl,
  extractTitle,
  extractJobsFromRecordMap,
  extractPageIdFromHtml,
  extractPageIdFromSlug,
  findCollectionViews,
  normalizePageId,
  parseNextData,
  parseDomFallback,
  shortId,
  unwrapBlockValue,
};
