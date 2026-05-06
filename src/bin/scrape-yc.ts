import { resolve } from 'node:path';
import { scrapeYC } from '../scrapers/yc';
import { openDbWrite } from '../lib/db-write';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

async function run() {
  const dbPath = resolve(process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH);
  const db = await openDbWrite(dbPath);

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
        description = excluded.description
    `);

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
    }

    const totalCount = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };

    console.log(
      `scraped ${BATCHES_COUNT} batches, ${companies.length} companies`
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
