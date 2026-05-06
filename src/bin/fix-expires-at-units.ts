/**
 * fix-expires-at-units.ts
 *
 * One-shot repair for listings.expires_at rows written in seconds.
 * Usage: bun run src/bin/fix-expires-at-units.ts
 * Override the database file with AI_NATIVE_JOBS_DB; otherwise this targets
 * ./ai-native-jobs.db in the current working directory.
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const DB_PATH = resolve(process.env.AI_NATIVE_JOBS_DB || './ai-native-jobs.db');
const MIN_UNIX_MS_EPOCH = 10_000_000_000;

const db = new Database(DB_PATH);

try {
  const countStmt = db.prepare(
    `SELECT COUNT(*) as count
     FROM listings
     WHERE expires_at < ? AND status = 'active'`,
  );
  const updateStmt = db.prepare(
    `UPDATE listings
     SET expires_at = expires_at * 1000
     WHERE expires_at < ? AND status = 'active'`,
  );

  const before = countStmt.get(MIN_UNIX_MS_EPOCH) as { count: number };
  const updated = updateStmt.run(MIN_UNIX_MS_EPOCH).changes;
  const after = countStmt.get(MIN_UNIX_MS_EPOCH) as { count: number };

  console.log(`before=${before.count} updated=${updated} after=${after.count}`);
} finally {
  db.close();
}
