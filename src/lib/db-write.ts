import type { Database } from 'bun:sqlite';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';

export function getDbPath(): string {
  return process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH;
}

/**
 * Open the SQLite database read-write, with foreign keys enabled.
 *
 * Distinct from the read-only `withDb` in `./db.ts` (used by the static build).
 * Always close via `.close()` in a `finally` block.
 */
export async function openDbWrite(dbPath = getDbPath()): Promise<Database> {
  const { Database: BunDatabase } = await import('bun:sqlite');
  const db = new BunDatabase(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export async function withDbWrite<T>(run: (db: Database) => T | Promise<T>): Promise<T> {
  const db = await openDbWrite();
  try {
    return await run(db);
  } finally {
    db.close();
  }
}
