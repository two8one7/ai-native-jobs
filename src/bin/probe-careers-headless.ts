/**
 * Headless-render fallback pass for SPA careers pages.
 *
 * Targets companies whose plain-HTML probe stamped `no_page` or `error` within
 * the last 30 days. Re-runs the probe with a CDP render fallback so SPA shells
 * (Webflow, Framer, Next.js client-only, Notion) can be inspected post-JS.
 *
 * Brain runs this manually after review. Not auto-scheduled.
 */
import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import type { CareersProbeResult, Company } from '../db/types';
import { renderViaCdp, type RenderResult } from '../scrapers/ats/cdp-render';
import {
  createCareersProbeScheduler,
  matchesBatch,
  probeCompanyCareersWithRender,
  type ProbeableCompany,
} from '../scrapers/ats/probe';
import { openDbWrite } from '../lib/db-write';

const DEFAULT_DB_PATH = './data/ai-native-jobs.db';
const RENDER_CONCURRENCY = 2;
const PER_HOST_DELAY_MS = 1_000;
const GLOBAL_DELAY_MS = 250;
const RECENT_PROBE_WINDOW_SECONDS = 30 * 86_400;

type CliArgs = {
  limit: number | null;
  only: string | null;
};

async function getDb(): Promise<Database> {
  return await openDbWrite(resolve(process.env.AINATIVE_DB_PATH ?? DEFAULT_DB_PATH));
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { limit: null, only: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--limit') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--limit requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid --limit value: ${next}`);
      }
      args.limit = parsed;
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

function getEligibleCompanies(db: Database, args: CliArgs): ProbeableCompany[] {
  const cutoffMs = (Math.floor(Date.now() / 1000) - RECENT_PROBE_WINDOW_SECONDS) * 1000;
  const rows = db
    .query(
      `SELECT *
       FROM companies
       WHERE website IS NOT NULL
         AND TRIM(website) <> ''
         AND careers_url IS NULL
         AND careers_probe_result IN ('no_page', 'error')
         AND careers_probe_at IS NOT NULL
         AND careers_probe_at >= ?
       ORDER BY yc_batch DESC, slug ASC`,
    )
    .all(cutoffMs) as Company[];

  const filtered = rows.filter((company) => matchesBatch(company, args.only));
  return args.limit ? filtered.slice(0, args.limit) : filtered;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolveFn) => setTimeout(resolveFn, ms));
}

/**
 * Per-host serialized render gate. Ensures we never render two URLs against
 * the same hostname concurrently AND inserts a polite delay between renders
 * on the same host. Concurrency across distinct hosts is bounded by
 * RENDER_CONCURRENCY via the global slot semaphore.
 */
class RenderGate {
  private readonly hostQueues = new Map<string, Promise<void>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private lastGlobalRenderAt = 0;

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    await this.acquireGlobalSlot();
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveFn) => {
      release = resolveFn;
    });
    this.hostQueues.set(host, previous.then(() => next));

    try {
      await previous;
      const sinceGlobal = Date.now() - this.lastGlobalRenderAt;
      if (sinceGlobal < GLOBAL_DELAY_MS) {
        await sleep(GLOBAL_DELAY_MS - sinceGlobal);
      }
      this.lastGlobalRenderAt = Date.now();

      const result = await task();
      // Polite per-host delay before the next render on the same host.
      await sleep(PER_HOST_DELAY_MS);
      return result;
    } finally {
      release();
      // GC: if no further renders queued for this host, drop the entry.
      // We can't introspect the chain head, so we replace by a fresh resolved
      // promise on next access.
      if (this.hostQueues.get(host) === previous.then(() => next)) {
        this.hostQueues.delete(host);
      }
      this.releaseGlobalSlot();
    }
  }

  private async acquireGlobalSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveFn) => this.waiters.push(resolveFn));
    this.active += 1;
  }

  private releaseGlobalSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

function getHost(company: ProbeableCompany): string {
  if (!company.website) {
    return 'unknown';
  }
  try {
    const url = company.website.startsWith('http')
      ? new URL(company.website)
      : new URL(`https://${company.website}`);
    return url.host;
  } catch {
    return 'unknown';
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await getDb();

  if (!process.env.TOMMYATO_BROWSER_CDP_URL) {
    console.error('TOMMYATO_BROWSER_CDP_URL is not set; nothing to render');
    process.exit(2);
  }

  const scheduler = createCareersProbeScheduler(6);
  const robotsCache = new Map<string, { disallow: string[] }>();
  const renderGate = new RenderGate(RENDER_CONCURRENCY);
  const companies = getEligibleCompanies(db, args);

  console.log(
    JSON.stringify({
      eligible: companies.length,
      only: args.only,
      limit: args.limit,
    }),
  );

  const updateStmt = db.prepare(`
    UPDATE companies
    SET careers_url = ?,
        ats_provider = ?,
        careers_probe_at = ?,
        careers_probe_result = ?
    WHERE id = ?
  `);

  const counts = { processed: 0, upgraded: 0, still_no_page: 0, errors: 0 };

  const render = async (
    url: string,
    opts?: { timeoutMs?: number; dwellMs?: number },
  ): Promise<RenderResult | null> => {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = 'unknown';
    }
    return renderGate.run(host, () => renderViaCdp(url, opts));
  };

  try {
    const tasks = companies.map(async (company) => {
      const previousResult = company.careers_probe_result as CareersProbeResult | null;
      try {
        const outcome = await probeCompanyCareersWithRender(
          company,
          scheduler,
          robotsCache,
          render,
        );

        updateStmt.run(
          outcome.careersUrl,
          outcome.atsProvider,
          Date.now(),
          outcome.result,
          company.id,
        );

        counts.processed += 1;
        if (outcome.result === 'found_ats' || outcome.result === 'found_custom') {
          counts.upgraded += 1;
        } else if (outcome.result === 'no_page') {
          counts.still_no_page += 1;
        } else if (outcome.result === 'error' || outcome.result === 'blocked') {
          counts.errors += 1;
        }

        console.log(
          JSON.stringify({
            slug: outcome.slug,
            host: getHost(company),
            previous: previousResult,
            result: outcome.result,
            careersUrl: outcome.careersUrl,
            atsProvider: outcome.atsProvider,
          }),
        );
      } catch (error) {
        counts.processed += 1;
        counts.errors += 1;
        console.error(
          JSON.stringify({
            slug: company.slug,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

    await Promise.all(tasks);

    console.log(
      `processed=${counts.processed} upgraded=${counts.upgraded} still_no_page=${counts.still_no_page} errors=${counts.errors}`,
    );
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error('headless careers probe failed:', error);
  process.exit(1);
});
