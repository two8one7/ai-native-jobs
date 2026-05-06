import { withDbWrite } from '../lib/db-write';

async function run() {
  await withDbWrite((db) => {
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE listings SET status = 'expired'
          WHERE status = 'active' AND expires_at < ?`,
      )
      .run(now);
    console.log(`sweep:expired updated=${result.changes}`);
  });
}

run().catch((e) => { console.error(e); process.exit(1); });
