import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import type { Company } from '../db/types';
import { scrapeCompanyListings } from '../scrapers/ats';
import type { ATSProvider } from '../scrapers/ats';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

type CompanyWithCareers = Company & { careers_url: string | null };

function getDb(): Database {
  return new Database(resolve(process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH));
}

function getCompanyBySlug(db: Database, slug: string): CompanyWithCareers | null {
  return db
    .query('SELECT * FROM companies WHERE slug = ?')
    .get(slug) as CompanyWithCareers | null;
}

function getCompaniesWithCareers(db: Database): CompanyWithCareers[] {
  return db
    .query('SELECT * FROM companies WHERE careers_url IS NOT NULL ORDER BY slug')
    .all() as CompanyWithCareers[];
}

function logSummary(
  companyCount: number,
  listingCount: number,
  byProvider: Record<ATSProvider, number>,
): void {
  const providerTotal =
    byProvider.greenhouse +
    byProvider.lever +
    byProvider.ashby +
    byProvider.smartrecruiters +
    byProvider.workable +
    byProvider.workday +
    byProvider.notion;
  console.log(
    `scraped ${companyCount} companies, ${listingCount} listings, ${providerTotal} by provider {greenhouse: ${byProvider.greenhouse}, lever: ${byProvider.lever}, ashby: ${byProvider.ashby}, smartrecruiters: ${byProvider.smartrecruiters}, workable: ${byProvider.workable}, workday: ${byProvider.workday}, notion: ${byProvider.notion}}`,
  );
}

async function runSingle(db: Database, slug: string): Promise<void> {
  const company = getCompanyBySlug(db, slug);
  if (!company) {
    throw new Error(`company not found: ${slug}`);
  }

  const result = await scrapeCompanyListings(db, company);
  console.log(JSON.stringify(result));
}

async function runAll(db: Database): Promise<void> {
  const companies = getCompaniesWithCareers(db);
  const byProvider: Record<ATSProvider, number> = {
    greenhouse: 0,
    lever: 0,
    ashby: 0,
    smartrecruiters: 0,
    workable: 0,
    workday: 0,
    notion: 0,
  };

  let scrapedCompanies = 0;
  let totalListings = 0;

  for (const company of companies) {
    try {
      const result = await scrapeCompanyListings(db, company);
      console.log(JSON.stringify(result));

      if (result.provider) {
        byProvider[result.provider] += result.listings;
      }
      totalListings += result.listings;
      scrapedCompanies += 1;
    } catch (error) {
      console.warn(
        JSON.stringify({
          slug: company.slug,
          provider: null,
          listings: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  logSummary(scrapedCompanies, totalListings, byProvider);
}

async function run(): Promise<void> {
  const db = getDb();
  const [, , command] = process.argv;

  try {
    if (command === 'all') {
      await runAll(db);
      return;
    }

    if (!command) {
      throw new Error('usage: bun run scrape:ats <company-slug> | bun run scrape:ats:all');
    }

    await runSingle(db, command);
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error('ATS scrape failed:', error);
  process.exit(1);
});
