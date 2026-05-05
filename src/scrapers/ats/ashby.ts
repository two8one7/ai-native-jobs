import type { RawJob } from './types';

type AshbyJobBoardResponse = {
  data?: {
    jobBoard?: {
      jobPostings?: Array<{
        id: string;
        title: string;
        locationName: string;
      }>;
    };
  };
};

type AshbyJobPostingResponse = {
  data?: {
    jobPosting?: {
      id: string;
      title: string;
      locationName: string;
      descriptionHtml: string;
      publishedDate: string;
    } | null;
  };
};

const ASHBY_URL = 'https://jobs.ashbyhq.com/api/non-user-graphql';

const JOB_BOARD_QUERY = `
  query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
    jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
      jobPostings {
        id
        title
        locationName
      }
    }
  }
`;

const JOB_POSTING_QUERY = `
  query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
    jobPosting(
      organizationHostedJobsPageName: $organizationHostedJobsPageName
      jobPostingId: $jobPostingId
    ) {
      id
      title
      locationName
      descriptionHtml
      publishedDate
    }
  }
`;

async function postAshby(body: unknown): Promise<Response> {
  return fetch(ASHBY_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(body),
  });
}

function snippet(text: string): string {
  return text.slice(0, 200).replace(/\s+/g, ' ').trim();
}

export async function fetchAshby(slug: string): Promise<RawJob[]> {
  const boardResponse = await postAshby({
    operationName: 'ApiJobBoardWithTeams',
    variables: { organizationHostedJobsPageName: slug },
    query: JOB_BOARD_QUERY,
  });

  if (!boardResponse.ok) {
    throw new Error(`Ashby fetch failed for ${slug}: ${boardResponse.status}`);
  }

  const boardData = (await boardResponse.json()) as AshbyJobBoardResponse;
  const postings = boardData.data?.jobBoard?.jobPostings ?? [];
  const jobs: RawJob[] = [];

  for (const posting of postings) {
    const detailResponse = await postAshby({
      operationName: 'ApiJobPosting',
      variables: {
        organizationHostedJobsPageName: slug,
        jobPostingId: posting.id,
      },
      query: JOB_POSTING_QUERY,
    });

    const detailText = await detailResponse.text();
    let detailData: AshbyJobPostingResponse;

    try {
      detailData = JSON.parse(detailText) as AshbyJobPostingResponse;
    } catch {
      console.warn(
        `Ashby parse failure for ${slug}/${posting.id}: ${detailResponse.status} ${snippet(detailText)}`
      );
      continue;
    }

    const job = detailData.data?.jobPosting;
    if (!job) {
      continue;
    }

    jobs.push({
      provider: 'ashby',
      providerJobId: job.id,
      title: job.title,
      location: job.locationName,
      description: job.descriptionHtml,
      applyUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}/${encodeURIComponent(job.id)}`,
      postedAt: job.publishedDate,
    });
  }

  return jobs;
}
