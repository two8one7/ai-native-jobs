import { createHash } from 'node:crypto';
import { parse, HTMLElement } from 'node-html-parser';
import type { RawJob } from './types';

const USER_AGENT = 'Mozilla/5.0';
const JOB_PATH_PATTERN = /\/(?:jobs?|careers?|positions?|openings?)\//i;
const LOCATION_PATTERN =
  /(remote|anywhere|hybrid|on[- ]?site|[A-Z][a-z]+,?\s*[A-Z]{2,})/i;
const BLACKLIST = new Set([
  'privacy policy',
  'terms',
  'contact',
  'about',
  'team',
  'blog',
  'pricing',
  'home',
  'login',
  'signin',
  'sign in',
  'signup',
  'sign up',
  'support',
  'help',
  'cookies',
  'careers',
  'apply',
  'apply now',
  'view details',
  'view all',
  'open roles',
  'open positions',
  'see all positions',
  'job description',
  'we re hiring',
  'folders and files',
  'footer',
  'learn more',
  'submit',
  'submit application',
]);

type JsonLdNode = {
  '@graph'?: unknown;
  '@id'?: unknown;
  '@type'?: unknown;
  title?: unknown;
  url?: unknown;
  description?: unknown;
  datePosted?: unknown;
  hiringOrganization?: {
    name?: unknown;
  } | null;
  jobLocation?:
    | {
        address?: {
          addressLocality?: unknown;
          addressCountry?: unknown;
        } | null;
      }
    | Array<{
        address?: {
          addressLocality?: unknown;
          addressCountry?: unknown;
        } | null;
      }>
    | null;
};

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function stripGenericTrail(value: string): string {
  return cleanText(
    value
      .replace(/(view\s*details|read\s*more|learn\s*more).*$/i, '')
      .replace(/\s*(remote|anywhere|hybrid|on[- ]?site)\s*$/i, '')
      .replace(/\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2,})\s*$/i, ''),
  );
}

function normalizedTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isBlacklistedTitle(title: string): boolean {
  const normalized = normalizedTitle(title);
  const withoutNumbers = normalized.replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim();
  return BLACKLIST.has(normalized) || BLACKLIST.has(withoutNumbers);
}

function makeProviderJobId(applyUrl: string): string {
  return createHash('sha1').update(applyUrl).digest('hex').slice(0, 8);
}

function isJobPostingType(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'jobposting';
  }

  if (Array.isArray(value)) {
    return value.some((entry) => isJobPostingType(entry));
  }

  return false;
}

function flattenJsonLdNodes(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenJsonLdNodes(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const node = value as JsonLdNode;
  const graphNodes = flattenJsonLdNodes(node['@graph']);
  return [node, ...graphNodes];
}

function extractCountry(value: unknown): string | null {
  if (typeof value === 'string') {
    return cleanText(value) || null;
  }

  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
    return cleanText(value.name) || null;
  }

  return null;
}

function extractJsonLdLocation(jobLocation: JsonLdNode['jobLocation']): string | null {
  const locations = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];

  for (const location of locations) {
    const locality =
      location?.address && typeof location.address.addressLocality === 'string'
        ? cleanText(location.address.addressLocality)
        : '';
    const country = extractCountry(location?.address?.addressCountry);
    const joined = [locality, country].filter(Boolean).join(', ');
    if (joined) {
      return joined;
    }
  }

  return null;
}

function resolveSameOriginJobUrl(
  href: string | null | undefined,
  careersUrl: URL,
): string | null {
  if (!href) {
    return null;
  }

  let absoluteUrl: URL;
  try {
    absoluteUrl = new URL(href, careersUrl);
  } catch {
    return null;
  }

  if (absoluteUrl.origin !== careersUrl.origin) {
    return null;
  }

  if (!JOB_PATH_PATTERN.test(absoluteUrl.pathname)) {
    return null;
  }

  if (absoluteUrl.pathname.replace(/\/+$/, '') === careersUrl.pathname.replace(/\/+$/, '')) {
    return null;
  }

  return absoluteUrl.toString();
}

function buildRawJob(
  title: string,
  applyUrl: string,
  location: string | null,
  description: string,
  postedAt: RawJob['postedAt'],
): RawJob | null {
  const normalized = cleanText(title);
  if (!normalized || isBlacklistedTitle(normalized)) {
    return null;
  }

  return {
    provider: 'custom',
    providerJobId: makeProviderJobId(applyUrl),
    title: normalized,
    location: location ? cleanText(location) : null,
    description,
    applyUrl,
    postedAt,
  };
}

function extractJsonLdJobs(root: HTMLElement, careersUrl: URL): RawJob[] {
  const jobs: RawJob[] = [];

  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.text.trim();
    if (!raw) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    for (const node of flattenJsonLdNodes(parsed)) {
      if (!isJobPostingType(node['@type'])) {
        continue;
      }

      const title = typeof node.title === 'string' ? node.title : '';
      const applyUrlSource =
        typeof node.url === 'string'
          ? node.url
          : typeof node['@id'] === 'string'
            ? node['@id']
            : careersUrl.toString();
      const applyUrl = (() => {
        try {
          return new URL(applyUrlSource, careersUrl).toString();
        } catch {
          return null;
        }
      })();

      if (!applyUrl) {
        continue;
      }

      const rawJob = buildRawJob(
        title,
        applyUrl,
        extractJsonLdLocation(node.jobLocation),
        typeof node.description === 'string' ? node.description : '',
        typeof node.datePosted === 'string' ? node.datePosted : null,
      );

      if (rawJob) {
        jobs.push(rawJob);
      }
    }
  }

  return jobs;
}

function findNearestLocation(container: HTMLElement, title: string): string | null {
  const normalizedTitle = cleanText(title);

  for (const node of container.querySelectorAll('span, p')) {
    const text = cleanText(node.text);
    if (!text || text === normalizedTitle) {
      continue;
    }

    if (LOCATION_PATTERN.test(text)) {
      return text;
    }
  }

  return null;
}

function extractAnchorJobs(root: HTMLElement, careersUrl: URL): RawJob[] {
  const jobs: RawJob[] = [];

  for (const anchor of root.querySelectorAll('a[href]')) {
    const title = stripGenericTrail(
      cleanText(
        anchor.querySelector('h1, h2, h3, h4, h5, h6')?.text ??
          (anchor.parentNode instanceof HTMLElement
            ? anchor.parentNode.querySelector('h1, h2, h3, h4, h5, h6')?.text ?? anchor.text
            : anchor.text),
      ),
    );
    if (title.length < 10 || title.length > 100 || isBlacklistedTitle(title)) {
      continue;
    }

    const applyUrl = resolveSameOriginJobUrl(anchor.getAttribute('href'), careersUrl);
    if (!applyUrl) {
      continue;
    }

    const parent = anchor.parentNode instanceof HTMLElement ? anchor.parentNode : null;
    const location = parent ? findNearestLocation(parent, title) : null;
    const rawJob = buildRawJob(title, applyUrl, location, '', null);
    if (rawJob) {
      jobs.push(rawJob);
    }
  }

  return jobs;
}

function getSiblingElement(
  element: HTMLElement,
  direction: 'previous' | 'next',
  steps: number,
): HTMLElement | null {
  let current: HTMLElement | null = element;

  for (let index = 0; index < steps; index += 1) {
    current =
      direction === 'previous'
        ? (current?.previousElementSibling as HTMLElement | null)
        : (current?.nextElementSibling as HTMLElement | null);

    if (!current) {
      return null;
    }
  }

  return current;
}

function findMatchingAnchor(
  scope: HTMLElement,
  careersUrl: URL,
): { applyUrl: string; anchorTitle: string } | null {
  for (const anchor of scope.querySelectorAll('a[href]')) {
    const applyUrl = resolveSameOriginJobUrl(anchor.getAttribute('href'), careersUrl);
    if (!applyUrl) {
      continue;
    }

    return { applyUrl, anchorTitle: cleanText(anchor.text) };
  }

  return null;
}

function extractHeadingPairJobs(root: HTMLElement, careersUrl: URL, seenApplyUrls: Set<string>): RawJob[] {
  const jobs: RawJob[] = [];

  for (const heading of root.querySelectorAll('h2, h3')) {
    const title = cleanText(heading.text);
    if (!title || isBlacklistedTitle(title)) {
      continue;
    }

    const parent = heading.parentNode instanceof HTMLElement ? heading.parentNode : null;
    if (!parent) {
      continue;
    }

    const neighborhoods = [
      parent,
      getSiblingElement(parent, 'previous', 1),
      getSiblingElement(parent, 'next', 1),
      getSiblingElement(parent, 'previous', 2),
      getSiblingElement(parent, 'next', 2),
    ].filter((entry): entry is HTMLElement => entry instanceof HTMLElement);

    for (const neighborhood of neighborhoods) {
      const match = findMatchingAnchor(neighborhood, careersUrl);
      if (!match || seenApplyUrls.has(match.applyUrl)) {
        continue;
      }

      let location: string | null = null;
      for (const locationScope of neighborhoods) {
        location = findNearestLocation(locationScope, title);
        if (location) {
          break;
        }
      }
      const rawJob = buildRawJob(title, match.applyUrl, location, '', null);
      if (rawJob) {
        jobs.push(rawJob);
        seenApplyUrls.add(match.applyUrl);
      }
      break;
    }
  }

  return jobs;
}

export function parseCustomHtml(html: string, careersUrl: string): RawJob[] {
  const careersUrlObject = new URL(careersUrl);
  const root = parse(html);
  const jsonLdJobs = extractJsonLdJobs(root, careersUrlObject);
  if (jsonLdJobs.length > 0) {
    return jsonLdJobs;
  }

  const anchorJobs = extractAnchorJobs(root, careersUrlObject);
  if (anchorJobs.length > 50) {
    return [];
  }

  const seenApplyUrls = new Set(anchorJobs.map((job) => job.applyUrl));
  const headingJobs = extractHeadingPairJobs(root, careersUrlObject, seenApplyUrls);
  const jobs = [...anchorJobs, ...headingJobs];

  return jobs.length > 50 ? [] : jobs;
}

export async function fetchCustom(careersUrl: string): Promise<RawJob[]> {
  const response = await fetch(careersUrl, {
    signal: AbortSignal.timeout(2000),
    headers: {
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Custom careers fetch failed for ${careersUrl}: ${response.status}`);
  }

  const html = await response.text();
  return parseCustomHtml(html, careersUrl);
}

export { makeProviderJobId };
