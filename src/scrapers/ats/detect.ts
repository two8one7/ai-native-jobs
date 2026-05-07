import type { DetectResult } from './types';

const WAAS_COMPANY_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?workatastartup\.com\/companies\/([a-z0-9-]+)(?:[/?#].*)?$/i;

// Careers/jobs/hiring tokens. Any of these in a Notion page slug or body sniff
// gates the detector to route to the `notion` provider — a Notion page without
// one of these tokens is almost certainly not a careers page (T&S docs,
// product guides, company one-pagers, etc.).
//
// Word-boundary anchored on either side to avoid matching e.g. "rolex" → "role".
const NOTION_CAREERS_TOKEN_PATTERN =
  /(?:^|[^a-z0-9])(careers?|jobs?|hiring|hire|roles?|positions?|openings?|we[-_]?are[-_]?hiring)(?:[^a-z0-9]|$)/i;

// True when the candidate text contains a careers-flavoured token. The check is
// run against the URL slug and (for body matches) the original input — both
// give a high-precision signal.
function hasCareersToken(value: string): boolean {
  return NOTION_CAREERS_TOKEN_PATTERN.test(value);
}
const WAAS_JOB_URL_PATTERN =
  /https?:\/\/(?:www\.)?workatastartup\.com\/companies\/([a-z0-9-]+)\/jobs\/[^"'\\s<]+/i;
const WAAS_JOB_PATH_PATTERN = /\/companies\/([a-z0-9-]+)\/jobs\/[^"'\\s<]+/i;
const WAAS_SLUG_DATA_PATTERN =
  /(?:&quot;|")slug(?:&quot;|")\s*:\s*(?:&quot;|")([a-z0-9-]+)(?:&quot;|")/i;
const WAAS_SIGNAL_PATTERNS = [
  'workatastartup.com',
  'bookface-images.s3.us-west-2.amazonaws.com',
  'bookface-images.s3.amazonaws.com',
] as const;

type PatternMatcher = {
  provider: DetectResult['provider'];
  pattern: RegExp;
  slug: (match: RegExpMatchArray) => string;
  // Optional post-match guard. When present and returns false, the match is
  // discarded and the next matcher is tried. Used by Notion patterns to demand
  // a careers/jobs/hiring token before routing — keeps T&S, product guides, and
  // company one-pagers from polluting the company table.
  validate?: (slug: string, source: string) => boolean;
};

// Notion patterns — match anything on notion.so / notion.site, but only route
// to the `notion` provider when the slug carries a careers/jobs/hiring token.
function notionGuard(slug: string, source: string): boolean {
  return hasCareersToken(slug) || hasCareersToken(source);
}

const URL_PATTERNS: PatternMatcher[] = [
  {
    provider: 'waas',
    pattern: WAAS_COMPANY_PATTERN,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'greenhouse',
    pattern: /^(?:https?:\/\/)?boards\.greenhouse\.io\/([a-z0-9-]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'greenhouse',
    pattern: /^(?:https?:\/\/)?job-boards\.greenhouse\.io\/([a-z0-9-]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'greenhouse',
    pattern: /^(?:https?:\/\/)?([a-z0-9-]+)\.greenhouse\.io(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'lever',
    pattern: /^(?:https?:\/\/)?jobs\.lever\.co\/([a-z0-9-]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'ashby',
    pattern: /^(?:https?:\/\/)?jobs\.ashbyhq\.com\/([^/?#]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'smartrecruiters',
    pattern: /^(?:https?:\/\/)?jobs\.smartrecruiters\.com\/([a-z0-9-]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'smartrecruiters',
    pattern: /^(?:https?:\/\/)?careers\.smartrecruiters\.com\/([a-z0-9-]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'workable',
    pattern: /^(?:https?:\/\/)?apply\.workable\.com\/([a-z0-9-]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'workable',
    pattern: /^(?:https?:\/\/)?([a-z0-9-]+)\.workable\.com(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'workday',
    pattern:
      /^(?:https?:\/\/)?([a-z0-9-]+)\.(wd[0-9]+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([^/?#]+)(?:[/?#].*)?$/i,
    slug: (match) =>
      `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}:${decodeURIComponent(match[4])}`,
  },
  // notion.site subdomain pages: https://<workspace>.notion.site/<page-path>
  // Capture workspace AND path so buildUrl can reconstruct the *.notion.site URL.
  // Slug form: "<workspace>:<path>" (e.g. "truemetrics-io:truemetrics-jobs").
  {
    provider: 'notion',
    pattern: /^(?:https?:\/\/)?([a-z0-9-]+)\.notion\.site\/([^/?#]+)(?:[/?#].*)?$/i,
    slug: (m) => `${m[1]}:${decodeURIComponent(m[2])}`,
    validate: notionGuard,
  },
  // notion.so workspace pages: https://www.notion.so/<workspace>/<page-id>
  // Page-id segment may have an optional title-slug prefix separated by '-', e.g.
  // "Anthropic-Careers-3b3c91be9aac4d5ca58d2e8e1c0a82c0". The non-capturing group
  // (?:[^/?#]+-) strips the prefix so match[2] is always the bare UUID. Fixes #12.
  //
  // Note: no careers-token guard here. notion.so workspace URLs are vetted by
  // the company-curation step (they only land in careers_url because someone
  // explicitly set them); the probe false-positives that motivated #33 are all
  // on *.notion.site subdomain pages.
  {
    provider: 'notion',
    pattern:
      /^(?:https?:\/\/)?(?:www\.)?notion\.so\/([^/?#]+)\/(?:[^/?#]+-)?([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[/?#].*)?$/i,
    slug: (match) =>
      `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`,
  },
];

const BODY_PATTERNS: PatternMatcher[] = [
  {
    provider: 'waas',
    pattern: WAAS_JOB_URL_PATTERN,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'greenhouse',
    pattern: /boards\.greenhouse\.io\/([a-z0-9-]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'greenhouse',
    pattern: /job-boards\.greenhouse\.io\/([a-z0-9-]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'greenhouse',
    pattern: /https?:\/\/([a-z0-9-]+)\.greenhouse\.io\b/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'lever',
    pattern: /jobs\.lever\.co\/([a-z0-9-]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'ashby',
    pattern: /jobs\.ashbyhq\.com\/([^"'\s<]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'smartrecruiters',
    pattern: /jobs\.smartrecruiters\.com\/([a-z0-9-]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'smartrecruiters',
    pattern: /careers\.smartrecruiters\.com\/([a-z0-9-]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'workable',
    pattern: /apply\.workable\.com\/([a-z0-9-]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'workable',
    pattern: /([a-z0-9-]+)\.workable\.com\b/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  {
    provider: 'workday',
    pattern:
      /([a-z0-9-]+)\.(wd[0-9]+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([^/?#"\s<]+)/i,
    slug: (match) =>
      `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}:${decodeURIComponent(match[4])}`,
  },
  // notion.site body pattern: picks up workspace + path after any *.notion.site/
  // Slug form: "<workspace>:<path>" — mirrors the URL_PATTERNS entry above.
  {
    provider: 'notion',
    pattern: /([a-z0-9-]+)\.notion\.site\/([^/?#"'\s<]+)/i,
    slug: (m) => `${m[1]}:${decodeURIComponent(m[2])}`,
    validate: notionGuard,
  },
  // notion.so body pattern: workspace + page UUID. Same slug-prefix fix as URL_PATTERNS. Fixes #12.
  // No careers-token guard here for the same reason as the URL pattern above.
  {
    provider: 'notion',
    pattern:
      /notion\.so\/([^/?#"'\s<]+)\/(?:[^/?#"'\s<]+-)?([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    slug: (match) =>
      `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`,
  },
  {
    provider: 'waas',
    pattern: WAAS_JOB_PATH_PATTERN,
    slug: (match) => decodeURIComponent(match[1]),
  },
];

function buildWaaSCompanyUrl(slug: string): string {
  return `https://www.workatastartup.com/companies/${slug}`;
}

function detectWaaSFromHtml(value: string): DetectResult {
  const jobPathMatch = value.match(WAAS_JOB_PATH_PATTERN);
  if (jobPathMatch) {
    return { provider: 'waas', slug: decodeURIComponent(jobPathMatch[1]) };
  }

  const jobUrlMatch = value.match(WAAS_JOB_URL_PATTERN);
  if (jobUrlMatch) {
    return { provider: 'waas', slug: decodeURIComponent(jobUrlMatch[1]) };
  }

  const hasSignal = WAAS_SIGNAL_PATTERNS.some((signal) => value.includes(signal));
  if (!hasSignal) {
    return { provider: null, slug: null };
  }

  const slugMatch = value.match(WAAS_SLUG_DATA_PATTERN);
  if (slugMatch) {
    return { provider: 'waas', slug: decodeURIComponent(slugMatch[1]) };
  }

  return { provider: null, slug: null };
}

function detectFromText(value: string): DetectResult {
  const trimmed = value.trim();

  const waas = detectWaaSFromHtml(trimmed);
  if (waas.provider) {
    return waas;
  }

  for (const matcher of URL_PATTERNS) {
    const match = trimmed.match(matcher.pattern);
    if (!match) continue;
    const slug = matcher.slug(match);
    if (matcher.validate && !matcher.validate(slug, trimmed)) continue;
    return { provider: matcher.provider, slug };
  }

  for (const matcher of BODY_PATTERNS) {
    const match = trimmed.match(matcher.pattern);
    if (!match) continue;
    const slug = matcher.slug(match);
    if (matcher.validate && !matcher.validate(slug, trimmed)) continue;
    return { provider: matcher.provider, slug };
  }

  return { provider: null, slug: null };
}

async function fetchBody(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      headers: {
        'user-agent': 'Mozilla/5.0',
      },
    });
    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

export async function detectATS(careersUrl: string | null | undefined): Promise<DetectResult> {
  if (!careersUrl || typeof careersUrl !== 'string') {
    return { provider: null, slug: null };
  }

  const direct = detectFromText(careersUrl);
  if (direct.provider) {
    return direct;
  }

  const body = await fetchBody(careersUrl);
  if (!body) {
    return { provider: null, slug: null };
  }

  const detectedFromBody = detectFromText(body);
  if (detectedFromBody.provider) {
    return detectedFromBody;
  }

  return body.trim() ? { provider: 'custom', slug: careersUrl } : { provider: null, slug: null };
}

export { detectFromText };
export { buildWaaSCompanyUrl, detectWaaSFromHtml };
