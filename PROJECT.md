# Project: PCBuildSage Free Hosted Demo & Dual-Mode Architecture

## Architecture
- **Dual-Mode System**: Default private local-first (`PCBUILDSAGE_DEPLOYMENT_MODE="local"`) vs public stateless hosted demo (`PCBUILDSAGE_DEPLOYMENT_MODE="hosted-demo"`).
- **Serving Plane**: Next.js 16 (App Router) containerized with `output: "standalone"` on Render Free web service. Strictly read-only, stateless, ephemeral filesystem.
- **Data Plane**:
  - Local mode: Embedded SQLite (`better-sqlite3`) on `data/products.db` and `data/sessions.db`.
  - Hosted mode: Turso SQLite Cloud (`@libsql/client`) over read-only HTTP/WebSocket with token authentication.
- **Ingestion Plane**: GitHub Actions scheduled workflow (`17 2 * * *`) executing Python scrapers into temporary runner SQLite, validating via 5-gate snapshot validator (`scripts/publish-catalog.ts`), and atomically publishing to Turso via `TURSO_INGEST_TOKEN`.
- **Client Plane**: Browser-owned state. Multi-tenant isolation achieved by storing sessions in browser IndexedDB (with `localStorage` fallback) and visitor BYOK LLM keys in ephemeral `sessionStorage`. Zero server-side session persistence or disk storage of credentials.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Deployment Mode Configuration | Environment variable `PCBUILDSAGE_DEPLOYMENT_MODE` supporting `"local"` (default) and `"hosted-demo"` with safe fallback | M0 | R1 |
| 2 | Route Guarding Middleware | Centralized route guard returning 403/404 in hosted mode for `/api/scrape`, `/api/profiles/*`, `/api/logs` | M0 | R1 |
| 3 | LLM Provider SSRF Prevention | Validate and sanitize custom provider `baseUrl` in `/api/chat`, strictly rejecting unauthorized endpoints in hosted mode | M0 | R1 |
| 4 | Public Market Metadata Endpoint | `GET /api/markets` returning supported countries, currencies, and locales without leaking internal scraper configs | M0 | R1 |
| 5 | Sanitized Status & Health Routes | `GET /api/health` and sanitized `GET /api/status` exposing freshness and status without leaking internal server paths | M0 | R1 |
| 6 | Async Catalog Repository Interface | `CatalogRepository` interface defining `getCatalog`, `searchProducts`, `getFreshness`, `getMarkets` | M1 | R2 |
| 7 | SQLite Catalog Repository Adapter | `SqliteCatalogRepository` using `better-sqlite3` maintaining 100% backward compatibility for local mode | M1 | R2 |
| 8 | Turso Catalog Repository Adapter | `TursoCatalogRepository` using `@libsql/client` for remote query execution | M1 | R2 |
| 9 | Source-Neutral ProductOffer Model | Normalized `ProductOffer` supporting `countryCode`, `currencyCode`, `price`, `retailer`, `sourceType`, `destinationUrl` | M1 | R2 |
| 10 | Catalog Tool Async Refactor | Adapt `get_catalog`, `search_products`, and `consult` tools to consume `CatalogRepository` asynchronously | M1 | R2 |
| 11 | Country & Subcategory Filtering | Preserve strict country filtering and `isBuildRelevant` internal subcategory rules across both repository backends | M1 | R2 |
| 12 | Snapshot Schema Version Validation | Gate 1 check: Ensure candidate SQLite DB matches target schema version (v5) and table structures | M2 | R3 |
| 13 | Drop Threshold & Anomaly Guard | Gate 2 check: Abort if total product count drops catastrophically (>50% reduction or 0 products) | M2 | R3 |
| 14 | Field & URL Integrity Validation | Gate 3 check: Validate required fields, positive non-zero prices, and well-formed retailer URLs | M2 | R3 |
| 15 | WAF & Bot Challenge Detection | Gate 4 check: Detect Cloudflare/Datadome challenge text or blocked HTML titles in scraped records | M2 | R3 |
| 16 | Stale Stock Sweep Ratio Gate | Gate 5 check: Validate sweep ratio safety before catalog finalization | M2 | R3 |
| 17 | Atomic Fail-Closed Turso Publisher | `scripts/publish-catalog.ts` publisher script that pushes candidate data to Turso and records `catalog_runs` | M2 | R3 |
| 18 | Browser-Owned Session Storage | Client-side IndexedDB store (with `localStorage` fallback) for chat sessions in hosted-demo mode | M3 | R4 |
| 19 | Ephemeral BYOK Key Management | Store visitor Gemini / OpenRouter API keys in browser `sessionStorage`, forward via headers, prevent server logging | M3 | R4 |
| 20 | Client Market Preference Persistence | Store user `MarketPreference` (`countryCode`, `currencyCode`, `locale`) client-side | M3 | R4 |
| 21 | Cross-Browser Isolation | Ensure zero shared server session database or disk persistence when running in hosted mode | M3 | R4 |
| 22 | Next.js Standalone Build Config | Enable `output: "standalone"` in `next.config.ts` | M4 | R5 |
| 23 | Production Multi-Stage Dockerfile | 3-stage `Dockerfile` (builder, runner) running as non-root `nextjs:nodejs`, bundling runtime registry assets | M4 | R5 |
| 24 | Dynamic Port Binding | Bind `$PORT` environment variable required by Render Free web services | M4 | R5 |
| 25 | Stateless Container Healthcheck | Container `/api/health` responding HTTP 200 on empty ephemeral filesystem without local writable DB | M4 | R5 |
| 26 | Scheduled Refresh CI Workflow | `.github/workflows/refresh-catalog.yml` with daily cron `17 2 * * *` and `workflow_dispatch` | M5 | R6 |
| 27 | Workflow Concurrency Serialization | Concurrency group configuration to prevent overlapping publisher executions | M5 | R6 |
| 28 | Runner-Local Ingestion Pipeline | GitHub Actions steps to install Python, run scraper into temporary DB, run acceptance validation | M5 | R6 |
| 29 | Fine-Grained Secret Security | Secure usage of `TURSO_INGEST_TOKEN` in CI vs read-only `TURSO_READ_TOKEN` on Render | M5 | R6 |
| 30 | Opaque-Box E2E Test Suite | Comprehensive 4-tier E2E testing suite validating requirements R1-R6 end-to-end | M6 | E2E |
| 31 | Local Mode Non-Regression Test Pass | Verify all 34 existing test suites (284 tests) and CLI run unchanged in local mode | M6 | Acceptance |
| 32 | Adversarial Stress & Hardening Suite | Tier 5 white-box mutation and stress testing uncovering edge case gaps | M7 | Tier 5 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M0 | Dual-Mode Deployment Contract & Route Guarding | R1 (Features 1-5) | none | DONE |
| M1 | Async Catalog Repository & Source-Neutral Offer Model | R2 (Features 6-11) | M0 | DONE |
| M2 | Ingestion Plane Snapshot Validator & Fail-Closed Turso Publisher | R3 (Features 12-17) | M1 | DONE |
| M3 | Browser-Owned State, Market Preference & BYOK Isolation | R4 (Features 18-21) | M0 | DONE |
| M4 | Next.js Standalone Containerization & Render Readiness | R5 (Features 22-25) | M0, M1, M3 | DONE |
| M5 | Scheduled Catalog Ingestion Workflow | R6 (Features 26-29) | M2 | DONE |
| M6 | E2E Testing Suite & Dual Track Acceptance (Tiers 1-4) | R1-R6 E2E Validation (Features 30-31) | M0, M1, M2, M3, M4, M5 | DONE |
| M7 | Adversarial Coverage Hardening (Tier 5) & Sentinel Sign-Off | Hardening & Verification (Feature 32) | M6 | PLANNED |

## Interface Contracts

### M0: Deployment Mode & Route Guarding
```typescript
export type DeploymentMode = "local" | "hosted-demo";

export function getDeploymentMode(): DeploymentMode;
export function isHostedDemo(): boolean;
export function isRouteBlockedInHostedMode(pathname: string, method?: string): boolean;
export function validateChatProviderUrl(url: string | undefined, mode: DeploymentMode): { allowed: boolean; reason?: string };

export interface MarketMetadata {
  code: string;
  name: string;
  defaultCurrency: string;
  supportedCurrencies: string[];
  locale: string;
}
```

### M1: Catalog Data Layer
```typescript
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

export interface CatalogRepository {
  getCatalog(countryCode?: string): Promise<Product[]>;
  searchProducts(query: SearchQuery, countryCode?: string): Promise<SearchResult>;
  getFreshness(): Promise<{ lastScraped: string | null; productCount: number }>;
  getMarkets(): Promise<MarketMetadata[]>;
  close(): Promise<void>;
}
```

### M2: Snapshot Validation & Ingestion
```typescript
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
  };
}

export function validateSnapshot(dbPath: string, baselineProductCount?: number): Promise<SnapshotValidationResult>;
export function publishToTurso(dbPath: string, tursoUrl: string, tursoToken: string): Promise<{ success: boolean; rowsSynced: number }>;
```

### M3: Browser State & BYOK Storage
```typescript
export interface MarketPreference {
  countryCode: string;
  currencyCode: string;
  locale: string;
}

export interface ClientSessionStore {
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  saveSession(session: SessionDetail): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
```

## Code Layout
```
pcbuildsage/
├── Dockerfile                                 # Multi-stage production container
├── .dockerignore                              # Docker ignore rules
├── next.config.ts                             # Next.js standalone config
├── scripts/
│   └── publish-catalog.ts                     # Turso ingestion publisher CLI
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── health/route.ts                # Stateless healthcheck
│   │   │   ├── markets/route.ts               # Public market metadata
│   │   │   ├── status/route.ts                # Sanitized status endpoint
│   │   │   ├── chat/route.ts                  # Chat route with SSRF protection
│   │   │   ├── scrape/route.ts                # Guarded against hosted-demo
│   │   │   ├── profiles/route.ts              # Guarded against hosted-demo
│   │   │   ├── profiles/import/route.ts       # Guarded against hosted-demo
│   │   │   ├── profiles/test/route.ts         # Guarded against hosted-demo
│   │   │   └── logs/route.ts                  # Guarded against hosted-demo
│   ├── lib/
│   │   ├── config/
│   │   │   └── deployment.ts                  # Deployment mode contract & helper
│   │   ├── middleware/
│   │   │   └── route-guard.ts                 # Centralized route policy
│   │   ├── db/
│   │   │   ├── repository.ts                  # CatalogRepository interface
│   │   │   ├── sqlite-repository.ts           # SqliteCatalogRepository (better-sqlite3)
│   │   │   ├── turso-repository.ts            # TursoCatalogRepository (@libsql/client)
│   │   │   ├── factory.ts                     # getCatalogRepository() factory
│   │   │   └── types.ts                       # Offer and product types
│   │   ├── ingestion/
│   │   │   └── validate-snapshot.ts           # 5-gate snapshot validation suite
│   │   └── client/
│   │       ├── indexeddb-sessions.ts          # Browser IndexedDB session storage
│   │       ├── byok-storage.ts                # Ephemeral sessionStorage BYOK manager
│   │       └── preferences.ts                 # Client market preference store
└── .github/
    └── workflows/
        └── refresh-catalog.yml                # Scheduled ingestion pipeline
```

## Open Decisions
- **Rate-limit tool step cap (25 vs 14)**: The rate-limit handoff document (`docs/handoff-rate-limit-and-subagents.html`) proposed lowering `stopWhen: isStepCount(25)` to `isStepCount(14)` in `src/lib/llm/chat-engine.ts` to conserve quota under heavy query fan-out. Following investigation in `docs/build-reliability-implementation-plan.html` ("no new request budget, lower step cap, persistence architecture, or resumable-execution system is prescribed; useful multi-build investigation must remain possible"), this remains an open decision and is intentionally not applied.

