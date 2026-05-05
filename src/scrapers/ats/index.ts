import type { Database } from 'bun:sqlite';
import type { Company } from '../../db/types';
import { detectATS } from './detect';
import { fetchAshby } from './ashby';
import { fetchGreenhouse } from './greenhouse';
import { fetchLever } from './lever';
import { normalizeRawJob } from './normalize';
import { upsertListings } from './store';
import type { ATSProvider, RawJob } from './types';

type CompanyWithCareers = Company & { careers_url: string | null };

const PROVIDER_FETCHERS: Record<ATSProvider, (slug: string) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
};

export type ScrapeCompanyResult = {
  slug: string;
  provider: ATSProvider | null;
  listings: number;
};

export async function scrapeCompanyListings(
  db: Database,
  company: CompanyWithCareers,
): Promise<ScrapeCompanyResult> {
  const detected = await detectATS(company.careers_url);
  if (!detected.provider || !detected.slug) {
    return { slug: company.slug, provider: null, listings: 0 };
  }

  const fetcher = PROVIDER_FETCHERS[detected.provider];
  const rawJobs = await fetcher(detected.slug);
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
