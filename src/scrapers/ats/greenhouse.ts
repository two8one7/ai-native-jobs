import type { RawJob } from './types';

type GreenhouseJob = {
  id: number;
  title: string;
  location?: { name?: string | null } | null;
  content?: string | null;
  absolute_url?: string | null;
  updated_at?: string | null;
};

type GreenhouseResponse = {
  jobs: GreenhouseJob[];
};

export async function fetchGreenhouse(slug: string): Promise<RawJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'user-agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Greenhouse fetch failed for ${slug}: ${response.status}`);
  }

  const data = (await response.json()) as GreenhouseResponse;
  return data.jobs.map((job) => ({
    provider: 'greenhouse',
    providerJobId: String(job.id),
    title: job.title,
    location: job.location?.name ?? null,
    description: job.content ?? '',
    applyUrl: job.absolute_url ?? `https://boards.greenhouse.io/${slug}`,
    postedAt: job.updated_at ?? null,
  }));
}
