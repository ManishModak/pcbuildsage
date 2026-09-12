import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================================
// Types & Interfaces (Matching PROJECT.md & TEST_INFRA.md Contracts)
// ============================================================================

export type DeploymentMode = "local" | "hosted-demo";

export interface MarketMetadata {
  code: string;
  name: string;
  defaultCurrency: string;
  supportedCurrencies: string[];
  locale: string;
}

export interface ProductOffer {
  id?: number;
  productId: string;
  countryCode: string;
  currencyCode: string;
  price: number;
  retailer: string;
  sourceType: "scraped" | "retailer-feed" | "manual" | "affiliate";
  destinationUrl: string;
  inStock: boolean;
  lastUpdated: string;
}

export interface Product {
  id: string;
  name: string;
  normalizedName?: string;
  registryKey?: string;
  price: number;
  currency: string;
  countryCode: string;
  retailer: string;
  url: string;
  imageUrl?: string;
  inStock: boolean;
  category: string;
  subcategory?: string;
  specs?: Record<string, unknown>;
  offers?: ProductOffer[];
  firstSeen: string;
  lastScraped: string;
}

export interface SearchQuery {
  term?: string;
  category?: string;
  subcategory?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  items: Product[];
  totalCount: number;
  facets?: {
    categories?: Record<string, number>;
    retailers?: Record<string, number>;
    priceRange?: { min: number; max: number };
  };
}

export interface CatalogRepository {
  getCatalog(countryCode?: string): Promise<Product[]>;
  searchProducts(query: SearchQuery, countryCode?: string): Promise<SearchResult>;
  getFreshness(): Promise<{ lastScraped: string | null; productCount: number }>;
  getMarkets(): Promise<MarketMetadata[]>;
  close(): Promise<void>;
}

export interface SnapshotValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    totalProducts: number;
    schemaVersion: number;
    priceErrors: number;
    corruptedUrls: number;
    wafDetections: number;
    sweepRatio?: number;
  };
}

export interface MarketPreference {
  countryCode: string;
  currencyCode: string;
  locale: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionDetail extends SessionSummary {
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: string;
  }>;
  marketPreference?: MarketPreference;
}

export interface ClientSessionStore {
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  saveSession(session: SessionDetail): Promise<void>;
  deleteSession(id: string): Promise<void>;
  clear(): Promise<void>;
}

// ============================================================================
// Standard Market Fixtures
// ============================================================================

export const STANDARD_MARKETS: MarketMetadata[] = [
  {
    code: "US",
    name: "United States",
    defaultCurrency: "USD",
    supportedCurrencies: ["USD"],
    locale: "en-US"
  },
  {
    code: "UK",
    name: "United Kingdom",
    defaultCurrency: "GBP",
    supportedCurrencies: ["GBP", "EUR"],
    locale: "en-GB"
  },
  {
    code: "IN",
    name: "India",
    defaultCurrency: "INR",
    supportedCurrencies: ["INR"],
    locale: "en-IN"
  },
  {
    code: "CA",
    name: "Canada",
    defaultCurrency: "CAD",
    supportedCurrencies: ["CAD", "USD"],
    locale: "en-CA"
  },
  {
    code: "DE",
    name: "Germany",
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR"],
    locale: "de-DE"
  }
];

// ============================================================================
// Reference Deployment Mode & Route Guard Helpers (Authoritative Contract)
// ============================================================================

export function resolveDeploymentMode(envVal?: string): DeploymentMode {
  const raw = envVal !== undefined ? envVal : process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  if (!raw) return "local";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "hosted-demo") {
    return "hosted-demo";
  }
  return "local";
}

export function isHostedDemoMode(envVal?: string): boolean {
  return resolveDeploymentMode(envVal) === "hosted-demo";
}

export const BLOCKED_HOSTED_ROUTES = [
  { path: "/api/scrape", methods: ["POST", "GET", "PUT", "DELETE"] },
  { path: "/api/profiles/import", methods: ["POST", "PUT"] },
  { path: "/api/profiles/test", methods: ["POST"] },
  { path: "/api/profiles", methods: ["GET", "POST", "PUT", "DELETE"] },
  { path: "/api/logs", methods: ["GET", "POST", "DELETE"] },
  { path: "/api/export-research", methods: ["POST", "GET", "PUT", "DELETE"] },
  { path: "/api/sessions", methods: ["POST", "GET", "PUT", "DELETE"] }
];

export function isRouteBlocked(pathname: string, method = "GET", mode: DeploymentMode = "hosted-demo"): boolean {
  if (mode === "local") return false;

  const cleanPath = pathname.split("?")[0].split("#")[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    decodedPath = cleanPath;
  }
  const collapsed = decodedPath.replace(/\/+/g, "/");
  const prefixed = collapsed.startsWith("/") ? collapsed : "/" + collapsed;
  const normalized = path.posix.normalize(prefixed);
  const normalizedPath = normalized.toLowerCase().replace(/\/+$/, "") || "/";
  const normalizedMethod = method.toUpperCase();

  for (const rule of BLOCKED_HOSTED_ROUTES) {
    const rulePath = rule.path.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath === rulePath || normalizedPath.startsWith(rulePath + "/")) {
      if (rule.methods.includes(normalizedMethod) || normalizedMethod === "ALL") {
        return true;
      }
    }
  }
  return false;
}

export const ALLOWED_CHAT_BASE_URLS = [
  "https://generativelanguage.googleapis.com",
  "https://openrouter.ai/api/v1",
  "https://api.openai.com/v1",
  "https://api.anthropic.com/v1"
];

export function validateChatUrl(url: string | undefined, mode: DeploymentMode): { allowed: boolean; reason?: string } {
  if (mode === "local") {
    return { allowed: true };
  }

  if (!url || url.trim() === "") {
    return { allowed: true };
  }

  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") {
      return { allowed: false, reason: "In hosted-demo mode, only secure HTTPS protocols are permitted." };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Reject localhost, loopbacks, internal IPs
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    ) {
      return { allowed: false, reason: "Access to private or internal addresses is strictly forbidden." };
    }

    // Check if matching whitelisted domains
    const isWhitelisted = ALLOWED_CHAT_BASE_URLS.some((allowed) => {
      const allowedParsed = new URL(allowed);
      return hostname === allowedParsed.hostname || hostname.endsWith("." + allowedParsed.hostname);
    });

    if (!isWhitelisted) {
      return { allowed: false, reason: `Custom endpoint '${hostname}' is not in the hosted-demo allowlist.` };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Malformed endpoint URL." };
  }
}

// ============================================================================
// Snapshot Validator (Authoritative 5-Gate Validation Implementation)
// ============================================================================

export const WAF_SIGNATURES = [
  "attention required",
  "cloudflare",
  "just a moment",
  "datadome",
  "ddos-guard",
  "captcha",
  "security check",
  "bot detection",
  "verify you are human"
];

export const NON_BUILD_RELEVANT_SUBCATEGORIES = [
  "flash-drive",
  "pen-drive",
  "usb-drive",
  "peripheral-cable",
  "mouse-pad",
  "desk-mat",
  "cleaning-kit",
  "blank-cd",
  "merchandise"
];

export async function validateCatalogSnapshot(
  dbPath: string,
  baselineProductCount = 0,
  options: { maxDropPercent?: number; maxSweepRatio?: number } = {}
): Promise<SnapshotValidationResult> {
  const maxDrop = options.maxDropPercent ?? 50;
  const maxSweepRatio = options.maxSweepRatio ?? 0.75;

  const errors: string[] = [];
  const warnings: string[] = [];
  const metrics = {
    totalProducts: 0,
    schemaVersion: 0,
    priceErrors: 0,
    corruptedUrls: 0,
    wafDetections: 0,
    sweepRatio: 0
  };

  if (!fs.existsSync(dbPath)) {
    return {
      valid: false,
      errors: [`Database file does not exist: ${dbPath}`],
      warnings: [],
      metrics
    };
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Failed to open SQLite database: ${msg}`],
      warnings: [],
      metrics
    };
  }

  try {
    // Gate 1: Schema version check
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    metrics.schemaVersion = userVersion;

    if (userVersion !== 5) {
      errors.push(`Gate 1 Failure: Invalid schema version ${userVersion}. Expected version 5.`);
    }

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (t) => t.name
    );
    if (!tables.includes("products")) {
      errors.push("Gate 1 Failure: Required table 'products' is missing.");
    }
    if (!tables.includes("audit_cache")) {
      warnings.push("Table 'audit_cache' is missing.");
    }
    if (!tables.includes("registry_research")) {
      warnings.push("Table 'registry_research' is missing.");
    }

    if (errors.length > 0 && !tables.includes("products")) {
      db.close();
      return { valid: false, errors, warnings, metrics };
    }

    // Gate 2: Product count & drop threshold check
    const countRow = db.prepare("SELECT COUNT(*) as count FROM products").get() as { count: number };
    metrics.totalProducts = countRow?.count ?? 0;

    if (metrics.totalProducts === 0) {
      errors.push("Gate 2 Failure: Candidate catalog contains 0 products (zero-product anomaly).");
    } else if (baselineProductCount > 0) {
      const dropRatio = (baselineProductCount - metrics.totalProducts) / baselineProductCount;
      const dropPercent = dropRatio * 100;
      if (dropPercent > maxDrop) {
        errors.push(
          `Gate 2 Failure: Product count dropped by ${dropPercent.toFixed(1)}% (${metrics.totalProducts} vs baseline ${baselineProductCount}), exceeding max allowed drop of ${maxDrop}%.`
        );
      }
    }

    // Gate 3 & Gate 4: Field integrity, price, URL & WAF checks
    const rows = db.prepare("SELECT id, name, price, url, retailer, category, in_stock FROM products").all() as Array<{
      id: string;
      name: string;
      price: number | null;
      url: string;
      retailer: string;
      category: string;
      in_stock: number;
    }>;

    let outOfStockCount = 0;

    for (const row of rows) {
      if (row.price === null || row.price === undefined || isNaN(row.price) || row.price <= 0) {
        metrics.priceErrors++;
      }

      if (!row.url || typeof row.url !== "string" || !/^https?:\/\/.+/i.test(row.url) || row.url.includes(" ")) {
        metrics.corruptedUrls++;
      }

      if (!row.id || !row.name || !row.category || !row.retailer) {
        metrics.corruptedUrls++;
      }

      const lowerName = (row.name || "").toLowerCase();
      const lowerUrl = (row.url || "").toLowerCase();
      const isWaf = WAF_SIGNATURES.some((sig) => lowerName.includes(sig) || lowerUrl.includes(sig));
      if (isWaf) {
        metrics.wafDetections++;
      }

      if (row.in_stock === 0) {
        outOfStockCount++;
      }
    }

    if (metrics.priceErrors > 0) {
      errors.push(`Gate 3 Failure: Detected ${metrics.priceErrors} products with non-positive or invalid prices.`);
    }
    if (metrics.corruptedUrls > 0) {
      errors.push(`Gate 3 Failure: Detected ${metrics.corruptedUrls} products with malformed URLs or missing required fields.`);
    }

    if (metrics.wafDetections > 0) {
      errors.push(`Gate 4 Failure: Detected ${metrics.wafDetections} products containing WAF challenge signatures or CAPTCHA text.`);
    }

    // Gate 5: Stale stock sweep ratio check
    if (metrics.totalProducts > 0) {
      const sweepRatio = outOfStockCount / metrics.totalProducts;
      metrics.sweepRatio = sweepRatio;
      if (sweepRatio > maxSweepRatio) {
        errors.push(
          `Gate 5 Failure: Stale sweep ratio ${(sweepRatio * 100).toFixed(1)}% exceeds maximum allowed threshold of ${(maxSweepRatio * 100).toFixed(1)}%.`
        );
      }
    }

    db.close();

    const valid = errors.length === 0;
    return {
      valid,
      errors,
      warnings,
      metrics
    };
  } catch (err: unknown) {
    if (db && db.open) db.close();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Validation execution error: ${msg}`],
      warnings,
      metrics
    };
  }
}

// ============================================================================
// Mock Turso Client & Fail-Closed Publisher
// ============================================================================

export class MockTursoClient {
  public open = true;
  public tables: Map<string, Array<Record<string, unknown>>> = new Map();
  public executedQueries: string[] = [];
  public transactions: Array<{ status: "committed" | "rolled-back"; queryCount: number }> = [];
  public shouldFail = false;
  public failureMessage = "Remote Turso connection failed";

  constructor() {
    this.tables.set("products", []);
    this.tables.set("catalog_runs", []);
    this.tables.set("product_offers", []);
  }

  async execute(stmt: { sql: string; args?: unknown[] } | string): Promise<{ rows: Array<Record<string, unknown>>; rowsAffected: number }> {
    if (!this.open) throw new Error("Client is closed");
    if (this.shouldFail) throw new Error(this.failureMessage);

    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    this.executedQueries.push(sql);

    const upper = sql.trim().toUpperCase();

    if (upper.startsWith("SELECT COUNT(*)")) {
      const prods = this.tables.get("products") || [];
      return { rows: [{ count: prods.length }], rowsAffected: 0 };
    }

    if (upper.startsWith("SELECT")) {
      const prods = this.tables.get("products") || [];
      return { rows: [...prods], rowsAffected: 0 };
    }

    if (upper.startsWith("INSERT INTO CATALOG_RUNS")) {
      const runs = this.tables.get("catalog_runs") || [];
      const args = typeof stmt === "object" ? stmt.args || [] : [];
      runs.push({ args, timestamp: new Date().toISOString() });
      this.tables.set("catalog_runs", runs);
      return { rows: [], rowsAffected: 1 };
    }

    return { rows: [], rowsAffected: 0 };
  }

  async batch(statements: Array<{ sql: string; args?: unknown[] } | string>): Promise<Array<{ rows: Array<Record<string, unknown>>; rowsAffected: number }>> {
    if (!this.open) throw new Error("Client is closed");
    if (this.shouldFail) {
      this.transactions.push({ status: "rolled-back", queryCount: statements.length });
      throw new Error(this.failureMessage);
    }

    const results = [];
    for (const stmt of statements) {
      results.push(await this.execute(stmt));
    }
    this.transactions.push({ status: "committed", queryCount: statements.length });
    return results;
  }

  async close(): Promise<void> {
    this.open = false;
  }
}

export async function publishCandidateToTurso(
  dbPath: string,
  tursoUrl: string,
  tursoToken: string,
  mockClient?: MockTursoClient,
  options: { baselineCount?: number } = {}
): Promise<{ success: boolean; rowsSynced: number; error?: string }> {
  const validation = await validateCatalogSnapshot(dbPath, options.baselineCount ?? 0);
  if (!validation.valid) {
    return {
      success: false,
      rowsSynced: 0,
      error: `Validation failed with ${validation.errors.length} errors: ${validation.errors.join("; ")}`
    };
  }

  if (!tursoUrl || !tursoToken) {
    return {
      success: false,
      rowsSynced: 0,
      error: "Missing Turso URL or token credentials."
    };
  }

  const client = mockClient || new MockTursoClient();
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM products").all() as Array<Record<string, unknown>>;
    db.close();

    const stmts = rows.map((r) => ({
      sql: "INSERT OR REPLACE INTO products (id, name, price, currency, country_code, retailer, url) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [r.id, r.name, r.price, r.currency, r.country_code, r.retailer, r.url]
    }));

    stmts.push({
      sql: "INSERT INTO catalog_runs (timestamp, product_count, status) VALUES (?, ?, ?)",
      args: [new Date().toISOString(), rows.length, "SUCCESS"]
    });

    await client.batch(stmts);

    return {
      success: true,
      rowsSynced: rows.length
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      rowsSynced: 0,
      error: `Publishing failed: ${msg}`
    };
  }
}

// ============================================================================
// Repository Reference Implementations
// ============================================================================

interface ProductDbRow {
  id: string;
  name: string;
  normalized_name?: string;
  registry_key?: string;
  price: number;
  currency: string;
  country_code: string;
  retailer: string;
  url: string;
  image_url?: string;
  in_stock: number;
  category: string;
  subcategory?: string;
  specs?: string;
  first_seen: string;
  last_scraped: string;
}

export class MemorySqliteRepository implements CatalogRepository {
  private db: Database.Database;

  constructor(dbPathOrDb?: string | Database.Database) {
    if (typeof dbPathOrDb === "string") {
      this.db = new Database(dbPathOrDb);
    } else if (dbPathOrDb) {
      this.db = dbPathOrDb;
    } else {
      this.db = new Database(":memory:");
      this.initSchema();
    }
  }

  private initSchema() {
    this.db.exec(`
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
    `);
  }

  async getCatalog(countryCode?: string): Promise<Product[]> {
    let sql = "SELECT * FROM products WHERE in_stock = 1";
    const params: unknown[] = [];
    if (countryCode) {
      sql += " AND country_code = ?";
      params.push(countryCode.toUpperCase());
    }

    const rows = this.db.prepare(sql).all(...params) as ProductDbRow[];
    return rows
      .filter((r) => !r.subcategory || !NON_BUILD_RELEVANT_SUBCATEGORIES.includes(r.subcategory.toLowerCase()))
      .map(this.mapRowToProduct);
  }

  async searchProducts(query: SearchQuery, countryCode?: string): Promise<SearchResult> {
    let sql = "SELECT * FROM products WHERE 1=1";
    const params: unknown[] = [];

    if (countryCode) {
      sql += " AND country_code = ?";
      params.push(countryCode.toUpperCase());
    }

    if (query.term) {
      sql += " AND (name LIKE ? OR normalized_name LIKE ?)";
      params.push(`%${query.term}%`, `%${query.term}%`);
    }

    if (query.category) {
      sql += " AND category = ?";
      params.push(query.category);
    }

    if (query.minPrice !== undefined) {
      sql += " AND price >= ?";
      params.push(query.minPrice);
    }

    if (query.maxPrice !== undefined) {
      sql += " AND price <= ?";
      params.push(query.maxPrice);
    }

    if (query.inStockOnly) {
      sql += " AND in_stock = 1";
    }

    const allRows = this.db.prepare(sql).all(...params) as ProductDbRow[];
    const filtered = allRows.filter(
      (r) => !r.subcategory || !NON_BUILD_RELEVANT_SUBCATEGORIES.includes(r.subcategory.toLowerCase())
    );

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const paged = filtered.slice(offset, offset + limit);

    return {
      items: paged.map(this.mapRowToProduct),
      totalCount: filtered.length
    };
  }

  async getFreshness(): Promise<{ lastScraped: string | null; productCount: number }> {
    const countRow = this.db.prepare("SELECT COUNT(*) as count, MAX(last_scraped) as lastScraped FROM products").get() as {
      count: number;
      lastScraped: string | null;
    };
    return {
      lastScraped: countRow?.lastScraped ?? null,
      productCount: countRow?.count ?? 0
    };
  }

  async getMarkets(): Promise<MarketMetadata[]> {
    return STANDARD_MARKETS;
  }

  async close(): Promise<void> {
    if (this.db.open) {
      this.db.close();
    }
  }

  private mapRowToProduct(r: ProductDbRow): Product {
    return {
      id: r.id,
      name: r.name,
      normalizedName: r.normalized_name,
      registryKey: r.registry_key,
      price: r.price,
      currency: r.currency,
      countryCode: r.country_code,
      retailer: r.retailer,
      url: r.url,
      imageUrl: r.image_url,
      inStock: Boolean(r.in_stock),
      category: r.category,
      subcategory: r.subcategory,
      firstSeen: r.first_seen || new Date().toISOString(),
      lastScraped: r.last_scraped || new Date().toISOString(),
      offers: [
        {
          productId: r.id,
          countryCode: r.country_code,
          currencyCode: r.currency,
          price: r.price,
          retailer: r.retailer,
          sourceType: "scraped",
          destinationUrl: r.url,
          inStock: Boolean(r.in_stock),
          lastUpdated: r.last_scraped || new Date().toISOString()
        }
      ]
    };
  }
}

export class MockTursoCatalogRepository implements CatalogRepository {
  public products: Product[] = [];
  public client: MockTursoClient;
  public closed = false;

  constructor(products: Product[] = [], client?: MockTursoClient) {
    this.products = products;
    this.client = client || new MockTursoClient();
  }

  async getCatalog(countryCode?: string): Promise<Product[]> {
    if (this.closed) throw new Error("Repository is closed");
    return this.products.filter(
      (p) =>
        (!countryCode || p.countryCode.toUpperCase() === countryCode.toUpperCase()) &&
        (!p.subcategory || !NON_BUILD_RELEVANT_SUBCATEGORIES.includes(p.subcategory.toLowerCase()))
    );
  }

  async searchProducts(query: SearchQuery, countryCode?: string): Promise<SearchResult> {
    if (this.closed) throw new Error("Repository is closed");
    let result = this.products.filter(
      (p) =>
        (!countryCode || p.countryCode.toUpperCase() === countryCode.toUpperCase()) &&
        (!p.subcategory || !NON_BUILD_RELEVANT_SUBCATEGORIES.includes(p.subcategory.toLowerCase()))
    );

    if (query.term) {
      const term = query.term.toLowerCase();
      result = result.filter(
        (p) => p.name.toLowerCase().includes(term) || (p.normalizedName && p.normalizedName.toLowerCase().includes(term))
      );
    }

    if (query.category) {
      result = result.filter((p) => p.category.toLowerCase() === query.category!.toLowerCase());
    }

    if (query.minPrice !== undefined) {
      result = result.filter((p) => p.price >= query.minPrice!);
    }

    if (query.maxPrice !== undefined) {
      result = result.filter((p) => p.price <= query.maxPrice!);
    }

    if (query.inStockOnly) {
      result = result.filter((p) => p.inStock);
    }

    const totalCount = result.length;
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    return {
      items: result.slice(offset, offset + limit),
      totalCount
    };
  }

  async getFreshness(): Promise<{ lastScraped: string | null; productCount: number }> {
    if (this.closed) throw new Error("Repository is closed");
    let maxScraped: string | null = null;
    for (const p of this.products) {
      if (!maxScraped || p.lastScraped > maxScraped) {
        maxScraped = p.lastScraped;
      }
    }
    return {
      lastScraped: maxScraped,
      productCount: this.products.length
    };
  }

  async getMarkets(): Promise<MarketMetadata[]> {
    if (this.closed) throw new Error("Repository is closed");
    return STANDARD_MARKETS;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }
}

// ============================================================================
// Client Browser Storage Mocks
// ============================================================================

export class MockBrowserSessionStore implements ClientSessionStore {
  private sessions: Map<string, SessionDetail> = new Map();
  public quotaLimit = Infinity;

  async listSessions(): Promise<SessionSummary[]> {
    return Array.from(this.sessions.values())
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(id: string): Promise<SessionDetail | null> {
    const session = this.sessions.get(id);
    return session ? JSON.parse(JSON.stringify(session)) : null;
  }

  async saveSession(session: SessionDetail): Promise<void> {
    const serialized = JSON.stringify(session);
    if (serialized.length > this.quotaLimit) {
      throw new Error("QuotaExceededError: DOMException quota limit exceeded");
    }
    this.sessions.set(session.id, JSON.parse(serialized));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async clear(): Promise<void> {
    this.sessions.clear();
  }
}

export class MockSessionStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get length(): number {
    return this.store.size;
  }
}

// ============================================================================
// Test Fixture Helpers
// ============================================================================

export function createMockProduct(overrides: Partial<Product> = {}): Product {
  const id = overrides.id !== undefined ? overrides.id : `prod-${Math.random().toString(36).substring(2, 9)}`;
  const price = overrides.price !== undefined ? overrides.price : 299.99;
  const currency = overrides.currency !== undefined ? overrides.currency : "USD";
  const countryCode = overrides.countryCode !== undefined ? overrides.countryCode : "US";
  const retailer = overrides.retailer !== undefined ? overrides.retailer : "BestBuy";
  const url = overrides.url !== undefined ? overrides.url : `https://example.com/item/${id}`;
  const name = overrides.name !== undefined ? overrides.name : "AMD Ryzen 7 7800X3D Desktop Processor";
  const normalizedName = overrides.normalizedName !== undefined ? overrides.normalizedName : "amd ryzen 7 7800x3d";
  const category = overrides.category !== undefined ? overrides.category : "cpu";

  return {
    id,
    name,
    normalizedName,
    registryKey: overrides.registryKey !== undefined ? overrides.registryKey : "cpu-amd-7800x3d",
    price,
    currency,
    countryCode,
    retailer,
    url,
    imageUrl: overrides.imageUrl !== undefined ? overrides.imageUrl : "https://example.com/img.jpg",
    inStock: overrides.inStock !== undefined ? overrides.inStock : true,
    category,
    subcategory: overrides.subcategory,
    specs: overrides.specs !== undefined ? overrides.specs : { cores: 8, threads: 16, tdp: 120 },
    firstSeen: overrides.firstSeen || new Date().toISOString(),
    lastScraped: overrides.lastScraped || new Date().toISOString(),
    offers: overrides.offers || [
      {
        productId: id,
        countryCode,
        currencyCode: currency,
        price,
        retailer,
        sourceType: "scraped",
        destinationUrl: url,
        inStock: overrides.inStock !== undefined ? overrides.inStock : true,
        lastUpdated: overrides.lastScraped || new Date().toISOString()
      }
    ]
  };
}

export function createTestSqliteDb(
  options: {
    schemaVersion?: number;
    products?: Array<Partial<Product>>;
    includeTables?: string[];
    dbPath?: string;
  } = {}
): { dbPath: string; db: Database.Database; cleanup: () => void } {
  const targetPath = options.dbPath || path.join(os.tmpdir(), `test-pcbuildsage-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.db`);
  const db = new Database(targetPath);

  const schemaVersion = options.schemaVersion !== undefined ? options.schemaVersion : 5;
  db.pragma(`user_version = ${schemaVersion}`);

  const tables = options.includeTables || ["products", "audit_cache", "registry_research"];

  if (tables.includes("products")) {
    db.exec(`
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
    `);
  }

  if (tables.includes("audit_cache")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_cache (
        pair_key TEXT PRIMARY KEY,
        verdict TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
    `);
  }

  if (tables.includes("registry_research")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS registry_research (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        specs TEXT NOT NULL,
        sources TEXT,
        confidence TEXT NOT NULL,
        researched_at TEXT NOT NULL
      );
    `);
  }

  if (options.products && tables.includes("products")) {
    const insertStmt = db.prepare(`
      INSERT INTO products (
        id, name, normalized_name, registry_key, price, currency,
        country_code, retailer, url, image_url, in_stock, category,
        subcategory, specs, first_seen, last_scraped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of options.products) {
      const full = createMockProduct(p);
      insertStmt.run(
        full.id,
        full.name,
        full.normalizedName || null,
        full.registryKey || null,
        full.price,
        full.currency,
        full.countryCode,
        full.retailer,
        full.url,
        full.imageUrl || null,
        full.inStock ? 1 : 0,
        full.category,
        full.subcategory || null,
        full.specs ? JSON.stringify(full.specs) : null,
        full.firstSeen,
        full.lastScraped
      );
    }
  }

  return {
    dbPath: targetPath,
    db,
    cleanup: () => {
      try {
        if (db.open) db.close();
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        if (fs.existsSync(`${targetPath}-wal`)) fs.unlinkSync(`${targetPath}-wal`);
        if (fs.existsSync(`${targetPath}-shm`)) fs.unlinkSync(`${targetPath}-shm`);
      } catch {
        // ignore
      }
    }
  };
}

// ============================================================================
// Dockerfile & Workflow Verification Parsers
// ============================================================================

export function parseDockerfile(dockerfileContent: string) {
  const lines = dockerfileContent.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));

  const fromStages: string[] = [];
  let user: string | null = null;
  const exposedPorts: string[] = [];
  const envVars: Record<string, string> = {};
  let outputStandaloneCopied = false;

  for (const line of lines) {
    if (/^FROM\s+/i.test(line)) {
      fromStages.push(line);
    } else if (/^USER\s+/i.test(line)) {
      user = line.replace(/^USER\s+/i, "").trim();
    } else if (/^EXPOSE\s+/i.test(line)) {
      exposedPorts.push(line.replace(/^EXPOSE\s+/i, "").trim());
    } else if (/^ENV\s+/i.test(line)) {
      const parts = line.replace(/^ENV\s+/i, "").trim().split("=");
      if (parts.length >= 2) {
        envVars[parts[0].trim()] = parts.slice(1).join("=").trim();
      }
    }

    if (line.includes(".next/standalone") || line.includes("standalone")) {
      outputStandaloneCopied = true;
    }
  }

  return {
    isMultiStage: fromStages.length >= 2,
    stagesCount: fromStages.length,
    user,
    isNonRoot: user !== null && user !== "root" && user !== "0",
    exposedPorts,
    envVars,
    isProductionEnv: envVars["NODE_ENV"] === "production",
    hasStandalone: outputStandaloneCopied
  };
}

export function parseWorkflowYaml(workflowContent: string) {
  const hasCron = /cron:\s*['"]([^'"]+)['"]/i.test(workflowContent);
  const cronMatch = workflowContent.match(/cron:\s*['"]([^'"]+)['"]/i);
  const hasWorkflowDispatch = /workflow_dispatch/i.test(workflowContent);
  const hasConcurrency = /concurrency:/i.test(workflowContent);
  const cancelInProgressFalse = /cancel-in-progress:\s*false/i.test(workflowContent);
  const usesIngestToken = /TURSO_INGEST_TOKEN/i.test(workflowContent);
  const usesReadToken = /TURSO_READ_TOKEN/i.test(workflowContent);
  const hasValidationStep = /validate/i.test(workflowContent);
  const hasScraperStep = /scraper|python/i.test(workflowContent);

  return {
    hasCron,
    cronSchedule: cronMatch ? cronMatch[1] : null,
    hasWorkflowDispatch,
    hasConcurrency,
    cancelInProgressFalse,
    usesIngestToken,
    usesReadToken,
    hasValidationStep,
    hasScraperStep
  };
}

export async function simulateDeploymentEnv<T>(mode: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const orig = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  try {
    if (mode === undefined) {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    } else {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = mode;
    }
    return await fn();
  } finally {
    if (orig === undefined) {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    } else {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = orig;
    }
  }
}
