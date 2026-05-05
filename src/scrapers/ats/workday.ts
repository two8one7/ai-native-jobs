import type { RawJob } from './types';

type WorkdayJobPosting = {
  title: string;
  externalPath: string;
  locationsText?: string | null;
  postedOn?: string | null;
  bulletFields?: string[] | null;
};

type WorkdayListResponse = {
  total: number;
  jobPostings: WorkdayJobPosting[];
};

type WorkdayJobDetail = {
  jobPostingInfo?: {
    jobPostingId?: string | null;
    jobDescription?: string | null;
    location?: {
      locationsText?: string | null;
      location?: string | null;
    } | null;
    postedOn?: string | null;
  } | null;
};

const PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseSlug(slug: string): { tenant: string; region: string; site: string } {
  const [tenant, region, site] = slug.split(':');

  if (!tenant || !region || !site) {
    throw new Error(`Workday slug must be tenant:region:site, got ${slug}`);
  }

  return { tenant, region, site };
}

export function parseWorkdayPostedOn(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) {
    return new Date(direct).toISOString();
  }

  const cleaned = trimmed.replace(/^Posted\s+/i, '').trim();
  const normalized = cleaned.toLowerCase();

  if (normalized === 'today') {
    return new Date(Date.now()).toISOString();
  }

  if (normalized === 'yesterday') {
    return new Date(Date.now() - DAY_MS).toISOString();
  }

  const daysAgoMatch = normalized.match(/^(\d+)\+?\s+days?\s+ago$/i);
  if (daysAgoMatch) {
    const days = Number(daysAgoMatch[1]);
    if (Number.isFinite(days)) {
      return new Date(Date.now() - days * DAY_MS).toISOString();
    }
  }

  return null;
}

function buildDescription(detail: WorkdayJobDetail['jobPostingInfo'], fallback: string | null): string {
  return detail?.jobDescription ?? fallback ?? '';
}

function buildLocation(
  posting: WorkdayJobPosting,
  detail: WorkdayJobDetail['jobPostingInfo'],
): string | null {
  return detail?.location?.locationsText ?? detail?.location?.location ?? posting.locationsText ?? null;
}

export async function fetchWorkday(slug: string): Promise<RawJob[]> {
  const { tenant, region, site } = parseSlug(slug);
  const jobs: RawJob[] = [];
  let offset = 0;

  while (true) {
    const listUrl = `https://${tenant}.${region}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
    const listResponse = await fetch(listUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset,
        searchText: '',
      }),
    });

    if (!listResponse.ok) {
      throw new Error(`Workday fetch failed for ${slug}: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as WorkdayListResponse;

    for (const posting of listData.jobPostings ?? []) {
      const detailUrl = `https://${tenant}.${region}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${posting.externalPath}`;
      const detailResponse = await fetch(detailUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          'user-agent': 'Mozilla/5.0',
        },
      });

      if (!detailResponse.ok) {
        console.warn(`Workday detail fetch failed for ${slug}${posting.externalPath}: ${detailResponse.status}`);
        continue;
      }

      const detail = (await detailResponse.json()) as WorkdayJobDetail;
      const jobPostingInfo = detail.jobPostingInfo;
      const providerJobId =
        jobPostingInfo?.jobPostingId ?? posting.bulletFields?.[0] ?? posting.externalPath;

      // Workday requires a per-posting detail fetch for the actual description; the list endpoint
      // only gives enough data to locate the job, so we mirror the N+1 pattern used elsewhere.
      jobs.push({
        provider: 'workday',
        providerJobId,
        title: posting.title,
        location: buildLocation(posting, jobPostingInfo),
        description: buildDescription(jobPostingInfo, ''),
        applyUrl: detailUrl,
        postedAt: parseWorkdayPostedOn(jobPostingInfo?.postedOn ?? posting.postedOn ?? null),
      });
    }

    const total = listData.total ?? 0;
    if (jobs.length >= total || (listData.jobPostings?.length ?? 0) < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return jobs;
}
