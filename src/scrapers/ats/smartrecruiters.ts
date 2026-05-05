import type { RawJob } from './types';

type SmartRecruitersPosting = {
  id: string;
  name: string;
  refNumber?: string | null;
  location?: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
    fullLocation?: string | null;
  } | null;
  releasedDate?: string | null;
  createdOn?: string | null;
};

type SmartRecruitersListResponse = {
  offset: number;
  limit: number;
  totalFound: number;
  content: SmartRecruitersPosting[];
};

type SmartRecruitersJobDetail = {
  id: string;
  name: string;
  location?: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
    fullLocation?: string | null;
  } | null;
  releasedDate?: string | null;
  jobAd?: {
    sections?: {
      companyDescription?: { text?: string | null } | null;
      jobDescription?: { text?: string | null } | null;
      qualifications?: { text?: string | null } | null;
      additionalInformation?: { text?: string | null } | null;
    } | null;
  } | null;
};

function buildDescription(jobAd: SmartRecruitersJobDetail['jobAd']): string {
  const sections: string[] = [];
  const jobAdSections = jobAd?.sections;

  if (jobAdSections?.companyDescription?.text) {
    sections.push(`<h3>Company Description</h3>${jobAdSections.companyDescription.text}`);
  }
  if (jobAdSections?.jobDescription?.text) {
    sections.push(`<h3>Job Description</h3>${jobAdSections.jobDescription.text}`);
  }
  if (jobAdSections?.qualifications?.text) {
    sections.push(`<h3>Qualifications</h3>${jobAdSections.qualifications.text}`);
  }
  if (jobAdSections?.additionalInformation?.text) {
    sections.push(`<h3>Additional Information</h3>${jobAdSections.additionalInformation.text}`);
  }

  return sections.join('\n');
}

export async function fetchSmartRecruiters(slug: string): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const listUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${limit}&offset=${offset}`;
    const listResponse = await fetch(listUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'user-agent': 'Mozilla/5.0',
      },
    });

    if (!listResponse.ok) {
      throw new Error(`SmartRecruiters fetch failed for ${slug}: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as SmartRecruitersListResponse;

    for (const posting of listData.content) {
      const detailUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(posting.id)}`;
      const detailResponse = await fetch(detailUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          'user-agent': 'Mozilla/5.0',
        },
      });

      if (!detailResponse.ok) {
        console.warn(`SmartRecruiters detail fetch failed for ${slug}/${posting.id}: ${detailResponse.status}`);
        continue;
      }

      const detail = (await detailResponse.json()) as SmartRecruitersJobDetail;
      const description = buildDescription(detail.jobAd);

      jobs.push({
        provider: 'smartrecruiters',
        providerJobId: posting.id,
        title: posting.name,
        location: posting.location?.fullLocation ?? posting.location?.city ?? null,
        description,
        applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(posting.id)}`,
        postedAt: posting.releasedDate ?? posting.createdOn ?? null,
      });
    }

    if (listData.content.length < limit || jobs.length >= listData.totalFound) {
      break;
    }

    offset += limit;
  }

  return jobs;
}
