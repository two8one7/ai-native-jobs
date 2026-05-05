import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { migrate } from './migrate';
import type { Company, Listing } from './types';

const smokeDbPath = resolve('./data/.smoke.db');

function removeSmokeFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${smokeDbPath}${suffix}`, { force: true });
  }
}

function runSmoke(): void {
  removeSmokeFiles();
  migrate(smokeDbPath);

  const db = new Database(smokeDbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');

    const company: Company = {
      id: '01smokecompany000000000000',
      slug: 'smoke-company',
      name: 'Smoke Company',
      yc_batch: 'S24',
      website: 'https://example.com',
      logo_url: 'https://example.com/logo.png',
      description: 'Testing the migration path.',
      created_at: 1_710_000_000_000,
    };

    const listing: Listing = {
      id: '01smokelisting000000000000',
      company_id: company.id,
      title: 'Senior Inference Engineer',
      location_city: 'San Francisco',
      location_country: 'US',
      location_is_remote: 1,
      location_policy: 'hybrid',
      comp_min: 180000,
      comp_max: 260000,
      comp_currency: 'USD',
      comp_equity: 1,
      ai_stack: JSON.stringify(['PyTorch', 'vLLM', 'CUDA']),
      ai_specialty: 'infra',
      ai_compute_access: '8x H100 cluster',
      description_html: '<p>Build the inference stack.</p>',
      apply_url: 'https://example.com/apply',
      posted_at: 1_710_000_000_000,
      expires_at: 1_712_592_000_000,
      status: 'active',
    };

    db.prepare(
      `INSERT INTO companies (
        id, slug, name, yc_batch, website, logo_url, description, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      company.id,
      company.slug,
      company.name,
      company.yc_batch,
      company.website,
      company.logo_url,
      company.description,
      company.created_at,
    );

    db.prepare(
      `INSERT INTO listings (
        id, company_id, title, location_city, location_country, location_is_remote,
        location_policy, comp_min, comp_max, comp_currency, comp_equity, ai_stack,
        ai_specialty, ai_compute_access, description_html, apply_url, posted_at,
        expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      listing.id,
      listing.company_id,
      listing.title,
      listing.location_city,
      listing.location_country,
      listing.location_is_remote,
      listing.location_policy,
      listing.comp_min,
      listing.comp_max,
      listing.comp_currency,
      listing.comp_equity,
      listing.ai_stack,
      listing.ai_specialty,
      listing.ai_compute_access,
      listing.description_html,
      listing.apply_url,
      listing.posted_at,
      listing.expires_at,
      listing.status,
    );

    const companyRow = db.prepare('SELECT * FROM companies WHERE id = ?').get(company.id) as Company | undefined;
    const listingRow = db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id) as Listing | undefined;

    if (!companyRow || !listingRow) {
      throw new Error('Smoke readback failed');
    }

    assert.equal(typeof companyRow.created_at, 'number');
    assert.equal(typeof companyRow.slug, 'string');
    assert.equal(typeof listingRow.location_is_remote, 'number');
    assert.equal(typeof listingRow.ai_stack, 'string');
    assert.equal(listingRow.status, 'active');
    assert.equal(companyRow.slug, company.slug);
    assert.equal(listingRow.company_id, company.id);
  } finally {
    db.close();
    removeSmokeFiles();
  }
}

try {
  runSmoke();
  console.log('db smoke passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
