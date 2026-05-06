import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import type { CareersProbeResult, Company, CompanyATSProvider } from '../db/types';
import {
  createCareersProbeScheduler,
  matchesBatch,
  probeCompanyCareers,
  shouldProbeCompany,
  type ProbeableCompany,
} from '../scrapers/ats/probe';
import { openDbWrite } from '../lib/db-write';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

type CliArgs = {
  limit: number | null;
  only: string | null;
};

type CountRow = {
  count: number;
};

type ProviderCountRow = {
  ats_provider: CompanyATSProvider | null;
  count: number;
};

async function getDb(): Promise<Database> {
  return await openDbWrite(resolve(process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH));
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    limit: null,
    only: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--limit') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--limit requires a value');
      }

      args.limit = Number.parseInt(next, 10);
      if (!Number.isFinite(args.limit) || args.limit <= 0) {
        throw new Error(`invalid --limit value: ${next}`);
      }
      index += 1;
      continue;
    }

    if (arg === '--only') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--only requires a value');
      }

      args.only = next;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function getEligibleCompanies(db: Database, filter: CliArgs): ProbeableCompany[] {
  const companies = db
    .query(
      `SELECT *
       FROM companies
       WHERE website IS NOT NULL
         AND TRIM(website) <> ''
         AND careers_url IS NULL
       ORDER BY yc_batch DESC, slug ASC`,
    )
    .all() as Company[];

  const filtered = companies.filter((company) => matchesBatch(company, filter.only) && shouldProbeCompany(company));
  return filter.limit ? filtered.slice(0, filter.limit) : filtered;
}

function countCompaniesWithCareers(db: Database): number {
  return (db.query('SELECT COUNT(*) AS count FROM companies WHERE careers_url IS NOT NULL').get() as CountRow).count;
}

function getProviderBreakdown(db: Database): ProviderCountRow[] {
  return db
    .query(
      `SELECT ats_provider, COUNT(*) AS count
       FROM companies
       WHERE careers_url IS NOT NULL
       GROUP BY ats_provider
       ORDER BY count DESC, ats_provider ASC`,
    )
    .all() as ProviderCountRow[];
}

function logSummary(
  beforeCount: number,
  afterCount: number,
  resultCounts: Record<CareersProbeResult, number>,
  providerCounts: ProviderCountRow[],
): void {
  const providerSummary = providerCounts
    .map((row) => `${row.ats_provider ?? 'unknown'}:${row.count}`)
    .join(', ');

  console.log(
    JSON.stringify({
      beforeCount,
      afterCount,
      delta: afterCount - beforeCount,
      results: resultCounts,
      providers: providerSummary,
    }),
  );
}

async function run(): Promise<void> {
  const db = getDb();
  const args = parseArgs(process.argv.slice(2));

  const scheduler = createCareersProbeScheduler(6);
  const robotsCache = new Map<string, { disallow: string[] }>();
  const beforeCount = countCompaniesWithCareers(db);
  const companies = getEligibleCompanies(db, args);
  const resultCounts: Record<CareersProbeResult, number> = {
    found_ats: 0,
    found_custom: 0,
    no_page: 0,
    blocked: 0,
    error: 0,
  };

  const updateStmt = db.prepare(`
    UPDATE companies
    SET careers_url = ?,
        ats_provider = ?,
        careers_probe_at = ?,
        careers_probe_result = ?
    WHERE id = ?
  `);

  try {
    console.log(
      JSON.stringify({
        eligible: companies.length,
        beforeCount,
        only: args.only,
        limit: args.limit,
      }),
    );

    const tasks = companies.map(async (company) => {
      const outcome = await probeCompanyCareers(company, scheduler, robotsCache);
      updateStmt.run(
        outcome.careersUrl,
        outcome.atsProvider,
        Date.now(),
        outcome.result,
        company.id,
      );
      resultCounts[outcome.result] += 1;
      console.log(JSON.stringify(outcome));
    });

    await Promise.all(tasks);

    const afterCount = countCompaniesWithCareers(db);
    logSummary(beforeCount, afterCount, resultCounts, getProviderBreakdown(db));
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error('careers probe failed:', error);
  process.exit(1);
});
