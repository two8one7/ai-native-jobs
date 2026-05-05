import type { RawJob } from './types';

type LeverPosting = {
  id: string;
  text: string;
  categories?: {
    location?: string | null;
    commitment?: string | null;
  } | null;
  descriptionPlain?: string | null;
  description?: string | null;
  hostedUrl?: string | null;
  createdAt?: number | null;
};

export async function fetchLever(slug: string): Promise<RawJob[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'user-agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Lever fetch failed for ${slug}: ${response.status}`);
  }

  const data = (await response.json()) as LeverPosting[];
  return data.map((job) => ({
    provider: 'lever',
    providerJobId: job.id,
    title: job.text,
    location: job.categories?.location ?? job.categories?.commitment ?? null,
    description: job.descriptionPlain ?? job.description ?? '',
    applyUrl: job.hostedUrl ?? `https://jobs.lever.co/${slug}`,
    postedAt: job.createdAt ?? null,
  }));
}
