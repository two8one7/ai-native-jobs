import type { DetectResult } from './types';

const URL_PATTERNS: Array<{ provider: DetectResult['provider']; pattern: RegExp }> = [
  {
    provider: 'greenhouse',
    pattern: /^(?:https?:\/\/)?boards\.greenhouse\.io\/([a-z0-9-]+)(?:[/?#].*)?$/i,
  },
  {
    provider: 'greenhouse',
    pattern: /^(?:https?:\/\/)?job-boards\.greenhouse\.io\/([a-z0-9-]+)(?:[/?#].*)?$/i,
  },
  {
    provider: 'greenhouse',
    pattern: /^(?:https?:\/\/)?([a-z0-9-]+)\.greenhouse\.io(?:[/?#].*)?$/i,
  },
  {
    provider: 'lever',
    pattern: /^(?:https?:\/\/)?jobs\.lever\.co\/([a-z0-9-]+)(?:[/?#].*)?$/i,
  },
  {
    provider: 'ashby',
    pattern: /^(?:https?:\/\/)?jobs\.ashbyhq\.com\/([^/?#]+)(?:[/?#].*)?$/i,
  },
];

const BODY_PATTERNS: Array<{ provider: DetectResult['provider']; pattern: RegExp }> = [
  { provider: 'greenhouse', pattern: /boards\.greenhouse\.io\/([a-z0-9-]+)/i },
  { provider: 'greenhouse', pattern: /job-boards\.greenhouse\.io\/([a-z0-9-]+)/i },
  { provider: 'greenhouse', pattern: /https?:\/\/([a-z0-9-]+)\.greenhouse\.io\b/i },
  { provider: 'lever', pattern: /jobs\.lever\.co\/([a-z0-9-]+)/i },
  { provider: 'ashby', pattern: /jobs\.ashbyhq\.com\/([^"'\\s<]+)/i },
];

function detectFromText(value: string): DetectResult {
  const trimmed = value.trim();

  for (const { provider, pattern } of URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { provider, slug: decodeURIComponent(match[1]) };
    }
  }

  for (const { provider, pattern } of BODY_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { provider, slug: decodeURIComponent(match[1]) };
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
