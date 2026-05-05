CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  yc_batch TEXT,
  website TEXT,
  logo_url TEXT,
  description TEXT,
  careers_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  location_city TEXT,
  location_country TEXT NOT NULL,
  location_is_remote INTEGER NOT NULL,
  location_policy TEXT NOT NULL CHECK(location_policy IN ('remote', 'hybrid', 'onsite')),
  comp_min INTEGER,
  comp_max INTEGER,
  comp_currency TEXT,
  comp_equity INTEGER,
  ai_stack TEXT NOT NULL DEFAULT '[]',
  ai_specialty TEXT CHECK(ai_specialty IN ('nlp', 'vision', 'robotics', 'infra', 'ops')),
  ai_compute_access TEXT,
  description_html TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'expired', 'filled'))
);

CREATE INDEX IF NOT EXISTS idx_listings_status_expires_at
  ON listings(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_listings_company_id
  ON listings(company_id);

CREATE INDEX IF NOT EXISTS idx_companies_slug
  ON companies(slug);
