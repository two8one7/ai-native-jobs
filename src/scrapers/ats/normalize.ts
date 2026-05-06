import type { ListingAISpecialty } from '../../db/types';
import type {
  AIJobListing,
  CompensationFields,
  LocationFields,
  NormalizeContext,
  RawJob,
  SpecialtyMatcher,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

const AI_STACK_PATTERNS: Array<{ token: string; pattern: RegExp }> = [
  { token: 'pytorch', pattern: /\bpytorch\b/i },
  { token: 'tensorflow', pattern: /\btensorflow\b/i },
  { token: 'jax', pattern: /\bjax\b/i },
  { token: 'triton', pattern: /\btriton\b/i },
  { token: 'cuda', pattern: /\bcuda\b/i },
  { token: 'vllm', pattern: /\bvllm\b/i },
  { token: 'tgi', pattern: /\btgi\b/i },
  { token: 'tensorrt', pattern: /\btensorrt\b/i },
  { token: 'xla', pattern: /\bxla\b/i },
  { token: 'mojo', pattern: /\bmojo\b/i },
  { token: 'rust', pattern: /\brust\b/i },
  { token: 'cuda kernels', pattern: /\bcuda kernels\b/i },
  { token: 'rlhf', pattern: /\brlhf\b/i },
  { token: 'dpo', pattern: /\bdpo\b/i },
  { token: 'lora', pattern: /\blora\b/i },
  { token: 'flash attention', pattern: /\bflash attention\b/i },
  { token: 'mixture of experts', pattern: /\bmixture of experts\b/i },
  { token: 'moe', pattern: /\bmoe\b/i },
  { token: 'transformers', pattern: /\btransformers\b/i },
];

const SPECIALTY_MATCHERS: SpecialtyMatcher[] = [
  {
    specialty: 'robotics',
    pattern: /\b(robotics|robot|autonomous vehicle|motion planning|manipulation)\b/i,
  },
  {
    specialty: 'vision',
    pattern: /\b(computer vision|vision model|image segmentation|ocr)\b/i,
  },
  {
    specialty: 'nlp',
    pattern: /\b(nlp|natural language|llm|language model|transformers|prompt)\b/i,
  },
  {
    specialty: 'infra',
    pattern: /\b(inference|serving|distributed systems|gpu|compiler|cuda|training infrastructure)\b/i,
  },
  {
    specialty: 'ops',
    pattern: /\b(mlops|platform reliability|sre|on-call|incident response|observability)\b/i,
  },
];

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '');
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePostedAt(value: RawJob['postedAt']): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function parseLocation(location: string | null): LocationFields {
  if (!location) {
    return {
      location_city: null,
      location_country: 'Unknown',
      location_is_remote: 0,
      location_policy: 'onsite',
    };
  }

  const normalized = location.replace(/[–—]/g, '-').trim();
  const lower = normalized.toLowerCase();
  const isHybrid = /\bhybrid\b/.test(lower);
  const isRemote = /\bremote\b/.test(lower);

  let location_policy: LocationFields['location_policy'] = 'onsite';
  let location_is_remote = 0;

  if (isHybrid) {
    location_policy = 'hybrid';
    location_is_remote = 1;
  } else if (isRemote) {
    location_policy = 'remote';
    location_is_remote = 1;
  }

  let remainder = normalized
    .replace(/\b(remote|hybrid|on[- ]?site)\b/gi, '')
    .replace(/^[\s:-]+|[\s:-]+$/g, '')
    .trim();

  if (!remainder) {
    return {
      location_city: null,
      location_country: isRemote ? 'Unknown' : 'Unknown',
      location_is_remote,
      location_policy,
    };
  }

  const parts = remainder.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      location_city: parts[0] || null,
      location_country: parts[parts.length - 1] || 'Unknown',
      location_is_remote,
      location_policy,
    };
  }

  if ((isRemote || isHybrid) && parts.length === 1) {
    return {
      location_city: null,
      location_country: parts[0] || 'Unknown',
      location_is_remote,
      location_policy,
    };
  }

  return {
    location_city: remainder || null,
    location_country: 'Unknown',
    location_is_remote,
    location_policy,
  };
}

function normalizeCompNumber(raw: string): number {
  const value = Number(raw.replace(/k/i, ''));
  return raw.toLowerCase().includes('k') ? value * 1000 : value;
}

function parseCompensation(title: string, description: string): CompensationFields {
  const haystack = `${title} ${description}`;
  const match = haystack.match(/\$(\d+)(k)?\s?(?:-|to|–)\s?\$?(\d+)(k)?/i);

  return {
    comp_min: match ? normalizeCompNumber(`${match[1]}${match[2] ?? ''}`) : null,
    comp_max: match ? normalizeCompNumber(`${match[3]}${match[4] ?? ''}`) : null,
    comp_currency: match ? 'USD' : null,
    comp_equity: /\bequity\b/i.test(haystack) ? 1 : null,
  };
}

function parseAIStack(text: string): string {
  const found: string[] = [];

  for (const { token, pattern } of AI_STACK_PATTERNS) {
    if (pattern.test(text)) {
      found.push(token);
    }
  }

  return JSON.stringify(found);
}

function parseAISpecialty(text: string): ListingAISpecialty | null {
  for (const matcher of SPECIALTY_MATCHERS) {
    if (matcher.pattern.test(text)) {
      return matcher.specialty;
    }
  }

  return null;
}

export function normalizeRawJob(rawJob: RawJob, context: NormalizeContext): AIJobListing {
  const postedAt = parsePostedAt(rawJob.postedAt);
  const description_html = sanitizeHtml(rawJob.description || '');
  const searchableText = `${rawJob.title} ${stripTags(description_html)}`;
  const location = parseLocation(rawJob.location);
  const compensation = parseCompensation(rawJob.title, searchableText);

  return {
    id: `${context.provider}:${context.providerSlug}:${rawJob.providerJobId}`,
    company_id: context.companyId,
    title: rawJob.title,
    location_city: location.location_city,
    location_country: location.location_country,
    location_is_remote: location.location_is_remote,
    location_policy: location.location_policy,
    comp_min: compensation.comp_min,
    comp_max: compensation.comp_max,
    comp_currency: compensation.comp_currency,
    comp_equity: compensation.comp_equity,
    ai_stack: parseAIStack(searchableText),
    ai_specialty: parseAISpecialty(searchableText),
    ai_compute_access: null,
    description_html,
    apply_url: rawJob.applyUrl,
    posted_at: postedAt,
    expires_at: postedAt + THIRTY_DAYS_MS,
    updated_at: postedAt,
    status: 'active',
  };
}

export { parseAISpecialty, parseAIStack, parseCompensation, parseLocation, sanitizeHtml, stripTags };
