import { resolve } from 'node:path';
import { openDbWrite } from '../lib/db-write';
import { seedCurated } from '../data/seed-curated';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

async function run() {
  const dbPath = resolve(process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH);
  const db = await openDbWrite(dbPath);

  try {
    console.log('seeding curated non-YC companies...');
    const count = seedCurated(db);
    console.log(`seeded ${count} curated companies`);

    const totalCount = db.query('SELECT COUNT(*) as count FROM companies').get() as { count: number };
    console.log(`total companies in db: ${totalCount.count}`);
  } finally {
    db.close();
  }
}

run().catch(err => {
  console.error('seed failed:', err);
  process.exit(1);
});
