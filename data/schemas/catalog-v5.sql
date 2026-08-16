CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT,
  registry_key TEXT,
  price REAL,
  currency TEXT NOT NULL,
  country_code TEXT NOT NULL,
  retailer TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  in_stock INTEGER DEFAULT 1,
  category TEXT NOT NULL,
  subcategory TEXT,
  specs TEXT,
  first_seen TEXT NOT NULL,
  last_scraped TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_url_unique ON products(url);
CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(country_code, currency, category, subcategory, price);
CREATE INDEX IF NOT EXISTS idx_products_norm ON products(normalized_name);
CREATE INDEX IF NOT EXISTS idx_products_retailer_sweep ON products(retailer, category, last_scraped);

CREATE TABLE IF NOT EXISTS audit_cache (
  pair_key TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registry_research (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  specs TEXT NOT NULL,
  sources TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  researched_at TEXT NOT NULL
);
