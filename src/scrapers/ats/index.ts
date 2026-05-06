import type { Database } from 'bun:sqlite';
import type { Company } from '../../db/types';
import { detectATS } from './detect';
import { detectFromText } from './detect';
import { fetchAshby } from './ashby';
import { fetchGreenhouse } from './greenhouse';
import { fetchLever } from './lever';
import { fetchSmartRecruiters } from './smartrecruiters';
import { fetchWorkable } from './workable';
import { fetchWorkday } from './workday';
import { fetchNotion } from './notion';
import { fetchCustom } from './custom';
import { scrapeWaaS } from './waas';
import { normalizeRawJob } from './normalize';
import { upsertListings } from './store';
import type { ATSProvider, RawJob } from './types';

const PROVIDER_FETCHERS: Record<ATSProvider, (slug: string) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  workday: fetchWorkday,
  notion: fetchNotion,
  waas: async () => [],
  custom: fetchCustom,
};

export type ScrapeCompanyResult = {
  slug: string;
  provider: ATSProvider | null;
  listings: number;
};

function resolveStoredProvider(company: Company): { provider: ATSProvider; slug: string } | null {
  if (!company.careers_url || !company.ats_provider) {
    return null;
  }

  if (company.ats_provider === 'custom') {
    return { provider: 'custom', slug: company.careers_url };
  }

  const detected = detectFromText(company.careers_url);
  if (!detected.provider || !detected.slug) {
    return null;
  }

  return {
    provider: company.ats_provider,
    slug: detected.slug,
  };
}

export async function scrapeCompanyListings(
  db: Database,
  company: Company,
): Promise<ScrapeCompanyResult> {
  const stored = resolveStoredProvider(company);
  const detected = stored ?? (await detectATS(company.careers_url));
  if (!detected.provider || !detected.slug) {
    return { slug: company.slug, provider: null, listings: 0 };
  }

  const rawJobs =
    detected.provider === 'waas'
      ? await scrapeWaaS(company, detected.slug)
      : await PROVIDER_FETCHERS[detected.provider](detected.slug);
  const listings = rawJobs.map((rawJob) =>
    normalizeRawJob(rawJob, {
      companyId: company.id,
      provider: detected.provider!,
      providerSlug: detected.slug!,
    }),
  );

  upsertListings(db, listings);
  return {
    slug: company.slug,
    provider: detected.provider,
    listings: listings.length,
  };
}

export type { ATSProvider, RawJob } from './types';
