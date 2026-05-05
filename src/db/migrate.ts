import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);

export function migrate(dbPath = process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH): string {
  const absoluteDbPath = resolve(dbPath);
  mkdirSync(dirname(absoluteDbPath), { recursive: true });

  const db = new Database(absoluteDbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  } finally {
    db.close();
  }

  return absoluteDbPath;
}

if (import.meta.main) {
  const dbPath = migrate();
  console.log(`migrated ${dbPath}`);
}
