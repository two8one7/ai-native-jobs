import type { RawJob } from './types';

type WorkableJob = {
  shortcode: string;
  title: string;
  full_title?: string | null;
  locations?: Array<{
    city?: string | null;
    country?: string | null;
    region?: string | null;
    location_str?: string | null;
  }> | null;
  department?: string | null;
  language?: string | null;
  published?: string | null;
  remote?: boolean | null;
};

type WorkableListResponse = {
  results: WorkableJob[];
  total: number;
};

function formatLocation(locations: WorkableJob['locations']): string | null {
  if (!locations || locations.length === 0) {
    return null;
  }
  return locations.map((loc) => loc.location_str ?? loc.city ?? loc.country).filter(Boolean).join(', ') || null;
}

export async function fetchWorkable(slug: string): Promise<RawJob[]> {
  const listUrl = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const listResponse = await fetch(listUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      query: '',
      department: [],
      location: [],
    }),
  });

  if (!listResponse.ok) {
    throw new Error(`Workable fetch failed for ${slug}: ${listResponse.status}`);
  }

  const listData = (await listResponse.json()) as WorkableListResponse;
  const jobs: RawJob[] = [];

  for (const job of listData.results) {
    jobs.push({
      provider: 'workable',
      providerJobId: job.shortcode,
      title: job.full_title ?? job.title,
      location: formatLocation(job.locations),
      description: '',
      applyUrl: `https://apply.workable.com/${encodeURIComponent(slug)}/j/${encodeURIComponent(job.shortcode)}/`,
      postedAt: job.published ?? null,
    });
  }

  return jobs;
}
