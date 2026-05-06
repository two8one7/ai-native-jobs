import { parse } from 'node-html-parser';
import type { CareersProbeResult, Company, CompanyATSProvider } from '../../db/types';
import { parseCustomHtml } from './custom';
import { detectFromText } from './detect';
import type { RenderResult, RenderOptions } from './cdp-render';

const USER_AGENT = 'ai-native-jobs-scraper/1.0 (+https://ai-native-jobs.tommyato.com)';
const USER_AGENT_TOKEN = USER_AGENT.split(/[\/\s]/, 1)[0].toLowerCase();
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;
const REPROBE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const COMMON_CAREERS_PATHS = ['/careers', '/jobs', '/join', '/work', '/hiring'];
const YC_JOBS_BASE_URL = 'https://www.ycombinator.com/companies';
const CAREERS_PATH_PATTERN = /\/(?:careers?|jobs?|join|work|hiring)(?:[/?#]|$)/i;
const CAREERS_TEXT_PATTERN =
  /\b(careers?|jobs?|open(?:ing|ings)?|positions?|roles?|join our team|we'?re hiring|hiring)\b/i;

export type ProbeableCompany = Pick<
  Company,
  | 'id'
  | 'slug'
  | 'name'
  | 'yc_batch'
  | 'website'
  | 'careers_url'
  | 'ats_provider'
  | 'careers_probe_at'
  | 'careers_probe_result'
>;

export type CareersProbeOutcome = {
  slug: string;
  careersUrl: string | null;
  atsProvider: CompanyATSProvider | null;
  result: CareersProbeResult;
  checkedUrls: string[];
  error: string | null;
};

type FetchTextResult = {
  url: string;
  ok: boolean;
  status: number;
  body: string;
  contentType: string | null;
};

type LinkCandidate = {
  absoluteUrl: string;
  text: string;
  sameOrigin: boolean;
};

type RobotsPolicy = {
  disallow: string[];
};

class HostFetchScheduler {
  private readonly hostQueues = new Map<string, Array<() => Promise<void>>>();
  private readonly blockedHosts = new Set<string>();
  private activeCount = 0;

  constructor(private readonly concurrency: number) {}

  run<T>(host: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.hostQueues.get(host) ?? [];
      queue.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
      this.hostQueues.set(host, queue);
      this.pump();
    });
  }

  private pump(): void {
    if (this.activeCount >= this.concurrency) {
      return;
    }

    for (const [host, queue] of this.hostQueues) {
      if (queue.length === 0 || this.blockedHosts.has(host) || this.activeCount >= this.concurrency) {
        continue;
      }

      const next = queue.shift();
      if (!next) {
        continue;
      }

      if (queue.length === 0) {
        this.hostQueues.delete(host);
      } else {
        this.hostQueues.set(host, queue);
      }

      this.blockedHosts.add(host);
      this.activeCount += 1;

      next().finally(() => {
        this.activeCount -= 1;
        this.blockedHosts.delete(host);
        this.pump();
      });
    }
  }
}

function normalizeBatch(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function normalizeWebsite(website: string): URL {
  try {
    return new URL(website);
  } catch {
    return new URL(`https://${website}`);
  }
}

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }

  return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
}

function isNegativeProbeResult(
  result: ProbeableCompany['careers_probe_result'],
): result is Extract<CareersProbeResult, 'no_page' | 'blocked' | 'error'> {
  return result === 'no_page' || result === 'blocked' || result === 'error';
}

export function shouldProbeCompany(company: ProbeableCompany, now = Date.now()): boolean {
  if (!company.website || company.careers_url) {
    return false;
  }

  if (!company.careers_probe_at || !isNegativeProbeResult(company.careers_probe_result)) {
    return true;
  }

  return company.careers_probe_at <= now - REPROBE_WINDOW_MS;
}

function matchesRobotsPattern(pattern: string, path: string): boolean {
  const normalized = pattern.trim();
  if (!normalized) {
    return false;
  }

  const anchorToEnd = normalized.endsWith('$');
  const source = (anchorToEnd ? normalized.slice(0, -1) : normalized)
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${source}${anchorToEnd ? '$' : ''}`);

  return regex.test(path);
}

export function parseRobotsDisallowRules(robotsText: string, userAgent = USER_AGENT_TOKEN): string[] {
  const exactRules: string[] = [];
  const wildcardRules: string[] = [];

  let currentAgents: string[] = [];
  let currentDisallow: string[] = [];

  const flush = () => {
    if (currentAgents.length === 0) {
      currentDisallow = [];
      return;
    }

    if (currentAgents.includes(userAgent)) {
      exactRules.push(...currentDisallow);
    } else if (currentAgents.includes('*')) {
      wildcardRules.push(...currentDisallow);
    }

    currentAgents = [];
    currentDisallow = [];
  };

  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (!line) {
      flush();
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const field = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (field === 'user-agent') {
      if (currentDisallow.length > 0) {
        flush();
      }

      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (field === 'disallow' && currentAgents.length > 0) {
      currentDisallow.push(value);
    }
  }

  flush();
  return exactRules.length > 0 ? exactRules : wildcardRules;
}

export function isPathAllowedByRobots(robotsText: string, path: string, userAgent = USER_AGENT_TOKEN): boolean {
  const disallowRules = parseRobotsDisallowRules(robotsText, userAgent);
  return !disallowRules.some((rule) => matchesRobotsPattern(rule, path));
}

async function fetchText(url: string): Promise<FetchTextResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const resetTimer = (ms: number) => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => controller.abort(`timeout after ${ms}ms`), ms);
  };

  try {
    resetTimer(CONNECT_TIMEOUT_MS);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
      },
    });

    resetTimer(READ_TIMEOUT_MS);
    const body = await response.text();

    return {
      url: response.url,
      ok: response.ok,
      status: response.status,
      body,
      contentType: response.headers.get('content-type'),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function extractLinks(html: string, pageUrl: string): LinkCandidate[] {
  const root = parse(html);
  const baseUrl = new URL(pageUrl);
  const seen = new Set<string>();
  const links: LinkCandidate[] = [];

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href) {
      continue;
    }

    let absoluteUrl: URL;
    try {
      absoluteUrl = new URL(href, baseUrl);
    } catch {
      continue;
    }

    if (!/^https?:$/.test(absoluteUrl.protocol) || seen.has(absoluteUrl.toString())) {
      continue;
    }

    seen.add(absoluteUrl.toString());
    links.push({
      absoluteUrl: absoluteUrl.toString(),
      text: anchor.text.trim(),
      sameOrigin: absoluteUrl.origin === baseUrl.origin,
    });
  }

  return links;
}

function findKnownAtsLink(links: LinkCandidate[]): { url: string; provider: CompanyATSProvider } | null {
  for (const link of links) {
    const detected = detectFromText(link.absoluteUrl);
    if (detected.provider) {
      return {
        url: link.absoluteUrl,
        provider: detected.provider,
      };
    }
  }

  return null;
}

function findCareerPageLinks(links: LinkCandidate[]): string[] {
  const candidates: string[] = [];

  for (const link of links) {
    const url = new URL(link.absoluteUrl);
    const looksLikeCareerLink =
      CAREERS_PATH_PATTERN.test(`${url.pathname}${url.hash}`) ||
      CAREERS_TEXT_PATTERN.test(link.text) ||
      /^jobs\./i.test(url.hostname);

    if (!looksLikeCareerLink) {
      continue;
    }

    candidates.push(url.toString());
  }

  return candidates;
}

function looksLikeCustomCareersPage(html: string, pageUrl: string): boolean {
  if (parseCustomHtml(html, pageUrl).length > 0) {
    return true;
  }

  const root = parse(html);
  const title = root.querySelector('title')?.text ?? '';
  const headingText = root
    .querySelectorAll('h1, h2, h3')
    .map((node) => node.text)
    .join(' ');

  return CAREERS_TEXT_PATTERN.test(`${title} ${headingText}`);
}

function isYcJobsPage(url: string): boolean {
  return url.startsWith(`${YC_JOBS_BASE_URL}/`) && /\/jobs(?:[/?#]|$)/.test(url);
}

async function getRobotsPolicy(
  siteUrl: URL,
  scheduler: HostFetchScheduler,
  robotsCache: Map<string, RobotsPolicy>,
): Promise<RobotsPolicy> {
  const cacheKey = siteUrl.origin;
  const cached = robotsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const robotsUrl = new URL('/robots.txt', siteUrl).toString();

  try {
    const response = await scheduler.run(siteUrl.host, () => fetchText(robotsUrl));
    const policy = response.ok
      ? { disallow: parseRobotsDisallowRules(response.body) }
      : { disallow: [] };
    robotsCache.set(cacheKey, policy);
    return policy;
  } catch {
    const policy = { disallow: [] };
    robotsCache.set(cacheKey, policy);
    return policy;
  }
}

async function isAllowedToFetchPath(
  siteUrl: URL,
  path: string,
  scheduler: HostFetchScheduler,
  robotsCache: Map<string, RobotsPolicy>,
): Promise<boolean> {
  const policy = await getRobotsPolicy(siteUrl, scheduler, robotsCache);
  return !policy.disallow.some((rule) => matchesRobotsPattern(rule, path));
}

type ProbeRunResult = {
  outcome: CareersProbeOutcome;
  totalHtmlBytes: number;
  websiteUrl: URL | null;
};

export async function probeCompanyCareers(
  company: ProbeableCompany,
  scheduler: HostFetchScheduler,
  robotsCache: Map<string, RobotsPolicy>,
): Promise<CareersProbeOutcome> {
  return (await runCareersProbe(company, scheduler, robotsCache)).outcome;
}

async function runCareersProbe(
  company: ProbeableCompany,
  scheduler: HostFetchScheduler,
  robotsCache: Map<string, RobotsPolicy>,
): Promise<ProbeRunResult> {
  if (!company.website) {
    return {
      outcome: {
        slug: company.slug,
        careersUrl: null,
        atsProvider: null,
        result: 'no_page',
        checkedUrls: [],
        error: null,
      },
      totalHtmlBytes: 0,
      websiteUrl: null,
    };
  }

  let websiteUrl: URL;
  try {
    websiteUrl = normalizeWebsite(company.website);
  } catch (error) {
    return {
      outcome: {
        slug: company.slug,
        careersUrl: null,
        atsProvider: null,
        result: 'error',
        checkedUrls: [],
        error: error instanceof Error ? error.message : String(error),
      },
      totalHtmlBytes: 0,
      websiteUrl: null,
    };
  }

  const checkedUrls: string[] = [];
  const queuedUrls = new Set<string>();
  const candidateQueue: string[] = [];
  let sawBlocked = false;
  let sawTransportError = false;
  let totalHtmlBytes = 0;

  const recordHtmlBytes = (page: FetchTextResult) => {
    if (page.ok && isHtmlContentType(page.contentType)) {
      totalHtmlBytes += page.body.length;
    }
  };

  const enqueue = (value: string) => {
    if (!queuedUrls.has(value)) {
      queuedUrls.add(value);
      candidateQueue.push(value);
    }
  };

  const homepageUrl = websiteUrl.toString();
  checkedUrls.push(homepageUrl);

  let homepage: FetchTextResult;
  try {
    homepage = await scheduler.run(websiteUrl.host, () => fetchText(homepageUrl));
  } catch (error) {
    return {
      outcome: {
        slug: company.slug,
        careersUrl: null,
        atsProvider: null,
        result: 'error',
        checkedUrls,
        error: error instanceof Error ? error.message : String(error),
      },
      totalHtmlBytes,
      websiteUrl,
    };
  }

  recordHtmlBytes(homepage);

  if (homepage.ok && isHtmlContentType(homepage.contentType)) {
    const directHomepageAts = detectFromText(homepage.url);
    if (directHomepageAts.provider) {
      return {
        outcome: {
          slug: company.slug,
          careersUrl: homepage.url,
          atsProvider: directHomepageAts.provider,
          result: 'found_ats',
          checkedUrls,
          error: null,
        },
        totalHtmlBytes,
        websiteUrl,
      };
    }

    const homepageLinks = extractLinks(homepage.body, homepage.url);
    const atsLink = findKnownAtsLink(homepageLinks);
    if (atsLink) {
      return {
        outcome: {
          slug: company.slug,
          careersUrl: atsLink.url,
          atsProvider: atsLink.provider,
          result: 'found_ats',
          checkedUrls,
          error: null,
        },
        totalHtmlBytes,
        websiteUrl,
      };
    }

    for (const path of COMMON_CAREERS_PATHS) {
      enqueue(new URL(path, homepage.url).toString());
    }

    for (const candidate of findCareerPageLinks(homepageLinks)) {
      enqueue(candidate);
    }
  } else if (homepage.status >= 400 && homepage.status < 600) {
    return {
      outcome: {
        slug: company.slug,
        careersUrl: null,
        atsProvider: null,
        result: 'no_page',
        checkedUrls,
        error: null,
      },
      totalHtmlBytes,
      websiteUrl,
    };
  }

  enqueue(`${YC_JOBS_BASE_URL}/${company.slug}/jobs`);

  while (candidateQueue.length > 0) {
    const candidate = candidateQueue.shift()!;
    const candidateUrl = new URL(candidate);

    if (!(await isAllowedToFetchPath(websiteUrl, candidateUrl.pathname, scheduler, robotsCache))) {
      sawBlocked = true;
      checkedUrls.push(candidate);
      continue;
    }

    checkedUrls.push(candidate);

    let page: FetchTextResult;
    try {
      page = await scheduler.run(candidateUrl.host, () => fetchText(candidate));
    } catch {
      sawTransportError = true;
      continue;
    }

    recordHtmlBytes(page);

    if (!page.ok) {
      if (page.status >= 400 && page.status < 600) {
        break;
      }
      continue;
    }

    const redirectedDetect = detectFromText(page.url);
    if (redirectedDetect.provider) {
      return {
        outcome: {
          slug: company.slug,
          careersUrl: page.url,
          atsProvider: redirectedDetect.provider,
          result: 'found_ats',
          checkedUrls,
          error: null,
        },
        totalHtmlBytes,
        websiteUrl,
      };
    }

    if (!isHtmlContentType(page.contentType)) {
      continue;
    }

    if (isYcJobsPage(page.url)) {
      return {
        outcome: {
          slug: company.slug,
          careersUrl: page.url,
          atsProvider: 'custom',
          result: 'found_custom',
          checkedUrls,
          error: null,
        },
        totalHtmlBytes,
        websiteUrl,
      };
    }

    const pageLinks = extractLinks(page.body, page.url);
    const atsLink = findKnownAtsLink(pageLinks);
    if (atsLink) {
      return {
        outcome: {
          slug: company.slug,
          careersUrl: atsLink.url,
          atsProvider: atsLink.provider,
          result: 'found_ats',
          checkedUrls,
          error: null,
        },
        totalHtmlBytes,
        websiteUrl,
      };
    }

    if (looksLikeCustomCareersPage(page.body, page.url)) {
      return {
        outcome: {
          slug: company.slug,
          careersUrl: page.url,
          atsProvider: 'custom',
          result: 'found_custom',
          checkedUrls,
          error: null,
        },
        totalHtmlBytes,
        websiteUrl,
      };
    }

    for (const followUp of findCareerPageLinks(pageLinks)) {
      enqueue(followUp);
    }
  }

  return {
    outcome: {
      slug: company.slug,
      careersUrl: null,
      atsProvider: null,
      result: sawBlocked ? 'blocked' : sawTransportError ? 'error' : 'no_page',
      checkedUrls,
      error: null,
    },
    totalHtmlBytes,
    websiteUrl,
  };
}

const PLAIN_HTML_SKIP_RENDER_BYTES = 30 * 1024;

export type RenderFn = (url: string, opts?: RenderOptions) => Promise<RenderResult | null>;

/**
 * Probe + render fallback. Runs the existing plain-HTML probe first; if it
 * returns 'no_page' AND the plain HTML it saw was small (< 30 KB total content
 * across the homepage and candidate URLs), invokes `render` against a small
 * candidate set (YC jobs page, website root, /careers) and reruns the same
 * detect + parseCustom logic against the post-JS HTML.
 *
 * The 30 KB skip rule: if plain HTML already returned a substantial body and
 * still found nothing, the company genuinely has no careers section — don't
 * waste a headless render.
 */
export async function probeCompanyCareersWithRender(
  company: ProbeableCompany,
  scheduler: HostFetchScheduler,
  robotsCache: Map<string, RobotsPolicy>,
  render: RenderFn,
): Promise<CareersProbeOutcome> {
  const { outcome, totalHtmlBytes, websiteUrl } = await runCareersProbe(
    company,
    scheduler,
    robotsCache,
  );

  if (outcome.result !== 'no_page') {
    return outcome;
  }

  if (totalHtmlBytes >= PLAIN_HTML_SKIP_RENDER_BYTES) {
    return outcome;
  }

  const candidates = buildRenderCandidates(company, websiteUrl);
  if (candidates.length === 0) {
    return outcome;
  }

  const checkedUrls = [...outcome.checkedUrls];

  for (const candidate of candidates) {
    let rendered: RenderResult | null;
    try {
      rendered = await render(candidate);
    } catch {
      rendered = null;
    }

    if (!rendered) {
      continue;
    }

    if (!checkedUrls.includes(rendered.finalUrl)) {
      checkedUrls.push(rendered.finalUrl);
    }

    const upgraded = inspectRenderedHtml(company, rendered, checkedUrls);
    if (upgraded) {
      return upgraded;
    }
  }

  return { ...outcome, checkedUrls };
}

function buildRenderCandidates(
  company: ProbeableCompany,
  websiteUrl: URL | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };

  push(`${YC_JOBS_BASE_URL}/${company.slug}/jobs`);

  if (websiteUrl) {
    push(websiteUrl.toString());
    try {
      push(new URL('/careers', websiteUrl).toString());
    } catch {
      // ignore
    }
  }

  return out;
}

function inspectRenderedHtml(
  company: ProbeableCompany,
  rendered: RenderResult,
  checkedUrls: string[],
): CareersProbeOutcome | null {
  const directDetect = detectFromText(rendered.finalUrl);
  if (directDetect.provider) {
    return {
      slug: company.slug,
      careersUrl: rendered.finalUrl,
      atsProvider: directDetect.provider,
      result: 'found_ats',
      checkedUrls,
      error: null,
    };
  }

  if (isYcJobsPage(rendered.finalUrl)) {
    return {
      slug: company.slug,
      careersUrl: rendered.finalUrl,
      atsProvider: 'custom',
      result: 'found_custom',
      checkedUrls,
      error: null,
    };
  }

  const links = extractLinks(rendered.html, rendered.finalUrl);
  const atsLink = findKnownAtsLink(links);
  if (atsLink) {
    return {
      slug: company.slug,
      careersUrl: atsLink.url,
      atsProvider: atsLink.provider,
      result: 'found_ats',
      checkedUrls,
      error: null,
    };
  }

  if (looksLikeCustomCareersPage(rendered.html, rendered.finalUrl)) {
    return {
      slug: company.slug,
      careersUrl: rendered.finalUrl,
      atsProvider: 'custom',
      result: 'found_custom',
      checkedUrls,
      error: null,
    };
  }

  return null;
}

export function createCareersProbeScheduler(concurrency = 6): HostFetchScheduler {
  return new HostFetchScheduler(concurrency);
}

export function matchesBatch(company: Pick<Company, 'yc_batch'>, filter: string | null): boolean {
  if (!filter) {
    return true;
  }

  return normalizeBatch(company.yc_batch) === normalizeBatch(filter);
}
