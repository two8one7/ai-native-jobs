import type { RawJob } from './types';

// Types for Notion's __NEXT_DATA__ recordMap structure (public pages, as of 2025-05)
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
};

type NotionBlock = {
  role?: string;
  value?: NotionBlockValue;
};

type NotionRecordMap = {
  block?: Record<string, NotionBlock>;
};

type NotionNextData = {
  props?: {
    pageProps?: {
      recordMap?: NotionRecordMap;
    };
  };
};

// Build the fetch URL from a slug.
// Slug formats:
//   "workspace:page-path"  → https://www.notion.so/workspace/page-path
//   "page-path"            → https://www.notion.so/page-path
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

// Extract a plain string from Notion's rich-text title format: [["Text", ...], ...].
function extractTitle(titleProp: NotionTitleSegment[] | undefined | null): string | null {
  if (!Array.isArray(titleProp) || titleProp.length === 0) {
    return null;
  }

  const firstSegment = titleProp[0];
  if (!Array.isArray(firstSegment) || firstSegment.length === 0) {
    return null;
  }

  return typeof firstSegment[0] === 'string' ? firstSegment[0] : null;
}

// Walk the recordMap.block, collect all page blocks whose parent is a collection.
// These are the "rows" of a Notion database (careers listings).
function extractJobsFromRecordMap(blockMap: Record<string, NotionBlock>): RawJob[] {
  const jobs: RawJob[] = [];

  for (const [blockId, block] of Object.entries(blockMap)) {
    const val = block?.value;
    if (!val || val.type !== 'page' || val.parent_table !== 'collection') {
      continue;
    }

    const title = extractTitle(val.properties?.title);
    if (!title) {
      continue;
    }

    const idNoDashes = blockId.replace(/-/g, '');
    const applyUrl = `https://www.notion.so/${idNoDashes}`;

    jobs.push({
      provider: 'notion',
      providerJobId: shortId(blockId),
      title,
      location: null,
      description: '',
      applyUrl,
      // last_edited_time is a Unix ms timestamp; convert to ISO string for normalizer.
      postedAt:
        typeof val.last_edited_time === 'number'
          ? new Date(val.last_edited_time).toISOString()
          : null,
    });
  }

  return jobs;
}

// Primary path: parse the __NEXT_DATA__ JSON blob embedded in the page's <script> tag.
function parseNextData(html: string): RawJob[] {
  const scriptMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!scriptMatch) {
    return [];
  }

  let data: NotionNextData;
  try {
    data = JSON.parse(scriptMatch[1]) as NotionNextData;
  } catch {
    return [];
  }

  const blockMap = data?.props?.pageProps?.recordMap?.block ?? {};
  return extractJobsFromRecordMap(blockMap);
}

// Fallback path: DOM parse for .notion-collection-row elements.
// Used when __NEXT_DATA__ is absent (older public pages or preview embeds).
function parseDomFallback(html: string): RawJob[] {
  const jobs: RawJob[] = [];

  // Each row element contains a link whose href ends in a 32-char hex page ID.
  const rowRegex =
    /<div[^>]+class="[^"]*notion-collection-row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)/gi;
  const linkRegex = /href="([^"]+)"[^>]*>([^<]+)</i;
  const pageIdRegex = /([a-f0-9]{32})(?:[/?#]|$)/i;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const linkMatch = rowHtml.match(linkRegex);
    if (!linkMatch) {
      continue;
    }

    const href = linkMatch[1].trim();
    const title = linkMatch[2].trim();
    if (!title) {
      continue;
    }

    const idMatch = href.replace(/-/g, '').match(pageIdRegex);
    if (!idMatch) {
      continue;
    }

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

export async function fetchNotion(slug: string): Promise<RawJob[]> {
  const url = buildUrl(slug);

  // Chrome UA — Googlebot 403s (reverse-DNS validation); Bingbot also 403s on notion.so
  // workspace pages. Chrome passes both *.notion.site and notion.so. Fixes #13.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Notion fetch failed for ${slug}: ${response.status}`);
  }

  const html = await response.text();

  // Primary: __NEXT_DATA__ JSON (reliable, present on all modern notion.so pages)
  const jobs = parseNextData(html);
  if (jobs.length > 0) {
    return jobs;
  }

  // Fallback: rendered DOM collection rows
  return parseDomFallback(html);
}

// Exported for testing
export { buildUrl, extractTitle, parseNextData, parseDomFallback, shortId };
