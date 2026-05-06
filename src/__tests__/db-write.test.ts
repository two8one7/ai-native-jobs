import { describe, it, expect } from 'bun:test';
import { openDbWrite } from '../lib/db-write';

describe('openDbWrite', () => {
  it('enables foreign_keys pragma', async () => {
    const db = await openDbWrite(':memory:');
    try {
      const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(result.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  });
});
