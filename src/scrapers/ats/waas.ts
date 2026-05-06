import type { Company } from '../../db/types';
import { buildWaaSCompanyUrl, detectFromText, detectWaaSFromHtml } from './detect';
import type { RawJob } from './types';

const USER_AGENT = 'Mozilla/5.0';
const COMMON_CAREERS_PATHS = ['', '/careers', '/jobs', '/join', '/work', '/hiring'];
const WAAS_BASE_URL = 'https://www.workatastartup.com';

type WaaSJob = {
  id?: number | string | null;
  title?: string | null;
  url?: string | null;
  applyUrl?: string | null;
  location?: string | null;
  description?: string | null;
  descriptionHtml?: string | null;
  type?: string | null;
  roleSpecificType?: string | null;
  salaryRange?: string | null;
  equityRange?: string | null;
  minExperience?: string | null;
  visa?: string | null;
  sponsorsVisa?: string | null;
  skills?: string[] | null;
  postedAt?: string | number | null;
};

type WaaSCompanyPayload = {
  slug?: string | null;
  long_description?: string | null;
  hiringDescriptionHtml?: string | null;
  techDescriptionHtml?: string | null;
  jobs?: WaaSJob[] | null;
};

type WaaSPagePayload = {
  props?: {
    company?: WaaSCompanyPayload | null;
  };
};

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function extractDataPage(html: string): WaaSPagePayload | null {
  const match = html.match(/data-page="([\s\S]*?)"\s*(?:id=|><\/div>|><)/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(decodeHtmlAttribute(match[1])) as WaaSPagePayload;
  } catch {
    return null;
  }
}

function extractCompanyPayload(html: string): WaaSCompanyPayload | null {
  return extractDataPage(html)?.props?.company ?? null;
}

function buildFallbackDescription(job: WaaSJob, company: WaaSCompanyPayload): string {
  const parts: string[] = [];
  const companyIntro = trimText(company.hiringDescriptionHtml ?? company.techDescriptionHtml ?? company.long_description);
  if (companyIntro) {
    parts.push(`<p>${escapeHtml(companyIntro)}</p>`);
  }

  const metaItems = [
    job.type ? `Type: ${trimText(job.type)}` : null,
    job.roleSpecificType ? `Role: ${trimText(job.roleSpecificType)}` : null,
    job.location ? `Location: ${trimText(job.location)}` : null,
    job.salaryRange ? `Salary: ${trimText(job.salaryRange)}` : null,
    job.equityRange ? `Equity: ${trimText(job.equityRange)}` : null,
    job.minExperience ? `Experience: ${trimText(job.minExperience)}` : null,
    (job.visa ?? job.sponsorsVisa) ? `Visa: ${trimText(job.visa ?? job.sponsorsVisa)}` : null,
  ].filter((value): value is string => Boolean(value));

  if (metaItems.length > 0) {
    parts.push(`<ul>${metaItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
  }

  if ((job.skills?.length ?? 0) > 0) {
    parts.push(`<p>Skills: ${escapeHtml(job.skills!.join(', '))}</p>`);
  }

  return parts.join('');
}

function buildFallbackApplyUrl(slug: string, job: WaaSJob): string {
  if (job.url) {
    return new URL(job.url, WAAS_BASE_URL).toString();
  }

  if (job.id != null) {
    return `${WAAS_BASE_URL}/application?signup_job_id=${encodeURIComponent(String(job.id))}`;
  }

  return buildWaaSCompanyUrl(slug);
}

function jobId(job: WaaSJob, applyUrl: string): string {
  if (job.id != null) {
    return String(job.id);
  }

  return applyUrl;
}

function toRawJobs(slug: string, company: WaaSCompanyPayload, jobs: WaaSJob[]): RawJob[] {
  const output: RawJob[] = [];

  for (const job of jobs) {
    const title = trimText(job.title);
    if (!title) {
      continue;
    }

    const applyUrl = buildFallbackApplyUrl(slug, job);
    if (!applyUrl.startsWith(WAAS_BASE_URL)) {
      continue;
    }

    output.push({
      provider: 'waas',
      providerJobId: jobId(job, applyUrl),
      title,
      location: trimText(job.location) || null,
      description:
        trimText(job.descriptionHtml) ||
        trimText(job.description) ||
        buildFallbackDescription(job, company),
      applyUrl,
      postedAt: job.postedAt ?? null,
    });
  }

  return output;
}

function parseWaaSCompanyHtml(html: string, slug: string): RawJob[] {
  const company = extractCompanyPayload(html);
  if (!company?.jobs?.length) {
    return [];
  }

  return toRawJobs(slug, company, company.jobs);
}

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.text();
}

async function tryFetchJobsJson(slug: string): Promise<RawJob[] | null> {
  const response = await fetch(`${buildWaaSCompanyUrl(slug)}/jobs.json`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  if (!Array.isArray(payload)) {
    return null;
  }

  const jobs = payload as WaaSJob[];
  return toRawJobs(slug, { slug, jobs }, jobs);
}

function buildWebsiteCandidates(website: string | null): string[] {
  if (!website) {
    return [];
  }

  let baseUrl: URL;
  try {
    baseUrl = website.startsWith('http') ? new URL(website) : new URL(`https://${website}`);
  } catch {
    return [];
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const path of COMMON_CAREERS_PATHS) {
    const candidate = new URL(path || '/', baseUrl).toString();
    if (!seen.has(candidate)) {
      seen.add(candidate);
      urls.push(candidate);
    }
  }

  return urls;
}

async function tryFetchEmbeddedWebsiteJobs(company: Company, slug: string): Promise<RawJob[]> {
  for (const candidate of buildWebsiteCandidates(company.website)) {
    let html: string | null = null;
    try {
      html = await fetchText(candidate);
    } catch {
      html = null;
    }

    if (!html) {
      continue;
    }

    const detected = detectWaaSFromHtml(html);
    if (detected.provider !== 'waas' || detected.slug !== slug) {
      continue;
    }

    const jobs = parseWaaSCompanyHtml(html, slug);
    if (jobs.length > 0) {
      return jobs;
    }
  }

  return [];
}

function getWaaSSlug(company: Company, knownSlug?: string): string {
  if (knownSlug) {
    return knownSlug;
  }

  const detected = detectFromText(company.careers_url ?? '');
  if (!detected.slug) {
    throw new Error(`WaaS careers_url missing slug for ${company.slug}`);
  }

  return detected.slug;
}

async function fetchCanonicalCompanyJobs(slug: string): Promise<RawJob[]> {
  const html = await fetchText(buildWaaSCompanyUrl(slug));
  if (!html) {
    throw new Error(`WaaS company fetch failed for ${slug}`);
  }

  return parseWaaSCompanyHtml(html, slug);
}

export async function scrapeWaaS(company: Company, knownSlug?: string): Promise<RawJob[]> {
  const slug = getWaaSSlug(company, knownSlug);

  const jsonJobs = await tryFetchJobsJson(slug);
  if (jsonJobs && jsonJobs.length > 0) {
    return jsonJobs;
  }

  const websiteJobs = await tryFetchEmbeddedWebsiteJobs(company, slug);
  if (websiteJobs.length > 0) {
    return websiteJobs;
  }

  const canonicalJobs = await fetchCanonicalCompanyJobs(slug);
  if (canonicalJobs.length > 0) {
    return canonicalJobs;
  }

  throw new Error(`WaaS scrape found no jobs for ${slug}`);
}

export { parseWaaSCompanyHtml };
