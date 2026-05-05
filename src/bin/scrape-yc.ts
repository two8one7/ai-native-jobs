import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { scrapeYC } from '../scrapers/yc';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

async function run() {
  const dbPath = resolve(process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH);
  const db = new Database(dbPath);

  try {
    console.log('scraping YC companies...');
    const companies = await scrapeYC();
    
    const upsertStmt = db.prepare(`
      INSERT INTO companies (id, slug, name, yc_batch, website, logo_url, description, careers_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        yc_batch = excluded.yc_batch,
        website = excluded.website,
        logo_url = excluded.logo_url,
        description = excluded.description,
        careers_url = excluded.careers_url
    `);

    let companiesWithCareers = 0;
    for (const company of companies) {
      upsertStmt.run(
        company.id,
        company.slug,
        company.name,
        company.yc_batch,
        company.website,
        company.logo_url,
        company.description,
        company.careers_url,
        company.created_at
      );
      if (company.careers_url) {
        companiesWithCareers++;
      }
    }

    const totalCount = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };

    console.log(
      `scraped ${BATCHES_COUNT} batches, ${companies.length} companies, ${companiesWithCareers} with careers_url`
    );
    console.log(`total companies in db: ${totalCount.count}`);
  } finally {
    db.close();
  }
}

const BATCHES_COUNT = 5;

run().catch(err => {
  console.error('scrape failed:', err);
  process.exit(1);
});
