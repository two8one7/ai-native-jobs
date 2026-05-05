import type { DetectResult } from './types';

type PatternMatcher = {
  provider: DetectResult['provider'];
  pattern: RegExp;
  slug: (match: RegExpMatchArray) => string;
};

const URL_PATTERNS: PatternMatcher[] = [
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
  {
    provider: 'notion',
    pattern: /^(?:https?:\/\/)?[a-z0-9-]+\.notion\.site\/([^/?#]+)(?:[/?#].*)?$/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  // notion.so workspace pages: https://www.notion.so/<workspace>/<page-id>
  {
    provider: 'notion',
    pattern:
      /^(?:https?:\/\/)?(?:www\.)?notion\.so\/([^/?#]+)\/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[/?#].*)?$/i,
    slug: (match) =>
      `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`,
  },
];

const BODY_PATTERNS: PatternMatcher[] = [
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
  // notion.site body pattern: picks up path after any *.notion.site/
  {
    provider: 'notion',
    pattern: /notion\.site\/([^/?#"'\s<]+)/i,
    slug: (match) => decodeURIComponent(match[1]),
  },
  // notion.so body pattern: workspace + page UUID
  {
    provider: 'notion',
    pattern:
      /notion\.so\/([^/?#"'\s<]+)\/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    slug: (match) =>
      `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`,
  },
];

function detectFromText(value: string): DetectResult {
  const trimmed = value.trim();

  for (const matcher of URL_PATTERNS) {
    const match = trimmed.match(matcher.pattern);
    if (match) {
      return { provider: matcher.provider, slug: matcher.slug(match) };
    }
  }

  for (const matcher of BODY_PATTERNS) {
    const match = trimmed.match(matcher.pattern);
    if (match) {
      return { provider: matcher.provider, slug: matcher.slug(match) };
    }
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

  return detectFromText(body);
}

export { detectFromText };
