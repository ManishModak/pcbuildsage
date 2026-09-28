/**
 * src/lib/config/deployment.ts
 *
 * Authoritative deployment contract, mode resolver, SSRF URL validator,
 * and market metadata registry.
 */

export type DeploymentMode = "local" | "hosted-demo";

export interface MarketMetadata {
  code: string;
  name: string;
  defaultCurrency: string;
  supportedCurrencies: string[];
  locale: string;
}

export interface RouteBlockRule {
  path: string;
  methods?: readonly string[];
}

export const BLOCKED_HOSTED_ROUTES: readonly RouteBlockRule[] = [
  { path: "/api/scrape", methods: ["POST", "GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
  { path: "/api/profiles/import", methods: ["POST", "PUT", "PATCH", "GET", "DELETE", "HEAD", "OPTIONS"] },
  { path: "/api/profiles/test", methods: ["POST", "GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
  { path: "/api/profiles", methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
  { path: "/api/logs", methods: ["GET", "POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"] },
  { path: "/api/export-research", methods: ["POST", "GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
  { path: "/api/sessions", methods: ["POST", "GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] }
] as const;

/**
 * Allowlisted public routes for hosted-demo mode (default-deny).
 * The Edge middleware permits only these `/api` prefixes; everything else
 * under `/api` is rejected with 403. Kept separate from BLOCKED_HOSTED_ROUTES
 * (retained for backwards-compatible handler-level checks) so the edge
 * default-deny posture is explicit.
 */
export interface RouteAllowRule {
  path: string;
  methods?: readonly string[];
}

export const ALLOWED_HOSTED_ROUTES: readonly RouteAllowRule[] = [
  { path: "/api/health" },
  { path: "/api/status" },
  { path: "/api/markets" },
  { path: "/api/chat" },
  { path: "/api/chat/compact" },
  { path: "/api/config" },
  { path: "/api/models" },
  { path: "/api/themes" },
  { path: "/api/personalities" },
  { path: "/api/endpoints" },
  { path: "/api/validate" },
  { path: "/api/search/probe" },
  { path: "/api/llm/probe" }
] as const;

export const ALLOWED_HOSTED_PROVIDER_DOMAINS: readonly string[] = [
  "googleapis.com",
  "openrouter.ai",
  "openai.com",
  "anthropic.com",
  "groq.com",
  "mistral.ai",
  "together.xyz",
  "together.ai",
  "deepseek.com",
  "cohere.com",
  "cohere.ai",
  "perplexity.ai"
] as const;

export const ALLOWED_CHAT_BASE_URLS: readonly string[] = [
  "https://generativelanguage.googleapis.com",
  "https://openrouter.ai/api/v1",
  "https://api.openai.com/v1",
  "https://api.anthropic.com/v1",
  "https://api.groq.com/openai/v1",
  "https://api.deepseek.com/v1"
] as const;

export const ALLOWED_SEARCH_PROVIDER_DOMAINS: readonly string[] = [
  "duckduckgo.com",
  "brave.com",
  "exa.ai",
  "tavily.com"
] as const;

export const ALLOWED_SEARCH_BASE_URLS: readonly string[] = [
  "https://html.duckduckgo.com",
  "https://api.search.brave.com",
  "https://api.exa.ai",
  "https://api.tavily.com"
] as const;

export const STANDARD_MARKETS: readonly MarketMetadata[] = [
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
] as const;

let hasWarnedUnsetMode = false;

export function resetDeploymentModeWarningForTesting() {
  hasWarnedUnsetMode = false;
}

export function warnIfProductionModeUnset(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): boolean {
  if (env.NODE_ENV === "production" && !env.PCBUILDSAGE_DEPLOYMENT_MODE) {
    if (!hasWarnedUnsetMode) {
      hasWarnedUnsetMode = true;
      console.warn(
        "Warning: PCBUILDSAGE_DEPLOYMENT_MODE is unset while NODE_ENV=production. Defaulting to 'local' mode."
      );
    }
    return true;
  }
  return false;
}

/**
 * Resolves the active deployment mode from environment.
 * Defaults safely to "local" if unset, empty, or unrecognized.
 */
export function getDeploymentMode(
  envOrString?: NodeJS.ProcessEnv | Record<string, string | undefined> | string
): DeploymentMode {
  let raw: string | undefined;
  const envObj = typeof envOrString === "object" && envOrString !== null ? envOrString : process.env;
  if (typeof envOrString === "string") {
    raw = envOrString;
  } else if (envOrString && typeof envOrString === "object") {
    raw = envOrString.PCBUILDSAGE_DEPLOYMENT_MODE;
  } else {
    raw = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  }

  if (envObj.NODE_ENV === "production" && !raw) {
    warnIfProductionModeUnset(envObj);
  }

  if (!raw) return "local";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "hosted-demo") {
    return "hosted-demo";
  }
  return "local";
}

/**
 * Convenience check for hosted-demo mode.
 */
export function isHostedDemo(
  envOrString?: NodeJS.ProcessEnv | Record<string, string | undefined> | string
): boolean {
  return getDeploymentMode(envOrString) === "hosted-demo";
}

/**
 * Convenience check for local mode.
 */
export function isLocal(
  envOrString?: NodeJS.ProcessEnv | Record<string, string | undefined> | string
): boolean {
  return getDeploymentMode(envOrString) === "local";
}

/**
 * Normalizes input paths by:
 * 1. Stripping query strings (?) and URL hashes (#)
 * 2. Safely decoding URL-encoded characters (%2f -> /, %73 -> s, etc.)
 * 3. Deduplicating repeated consecutive slashes (//api//scrape -> /api/scrape)
 * 4. Resolving relative dot segments (. and ..) via POSIX path normalization
 * 5. Lowercasing and stripping trailing slashes
 */
export function normalizeRoutePath(rawPath: string): string {
  if (!rawPath) return "/";
  const cleanPath = rawPath.split("?")[0].split("#")[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    decodedPath = cleanPath;
  }

  const segments = decodedPath.split("/");
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length > 0) {
        stack.pop();
      }
    } else {
      stack.push(segment.toLowerCase());
    }
  }

  return "/" + stack.join("/");
}

/**
 * Returns true if a given path and HTTP method must be blocked in the target deployment mode.
 * Retained for backwards-compatible handler-level checks; the Edge middleware
 * now uses the allowlist below (default-deny).
 */
export function isRouteBlockedInHostedMode(
  pathname: string,
  method = "GET",
  mode: DeploymentMode = getDeploymentMode()
): boolean {
  if (mode === "local") return false;

  const normalizedPath = normalizeRoutePath(pathname);
  const normalizedMethod = method.toUpperCase();

  for (const rule of BLOCKED_HOSTED_ROUTES) {
    const rulePath = rule.path.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath === rulePath || normalizedPath.startsWith(rulePath + "/")) {
      if (!rule.methods || rule.methods.includes(normalizedMethod) || normalizedMethod === "ALL") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Allowlist check for hosted-demo mode (default-deny).
 * Returns true only for explicitly listed public `/api` routes; in local mode
 * every route is allowed. The Edge middleware uses this instead of the
 * blocklist above so unknown `/api` paths fail closed.
 */
export function isRouteAllowedInHostedMode(
  pathname: string,
  method = "GET",
  mode: DeploymentMode = getDeploymentMode()
): boolean {
  if (mode === "local") return true;

  const normalizedPath = normalizeRoutePath(pathname);
  const normalizedMethod = method.toUpperCase();

  for (const rule of ALLOWED_HOSTED_ROUTES) {
    const rulePath = rule.path.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath === rulePath || normalizedPath.startsWith(rulePath + "/")) {
      if (!rule.methods || rule.methods.includes(normalizedMethod) || normalizedMethod === "ALL") {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hosted per-IP rate limiting (simple in-memory token bucket).
// Reusable by the hosted chat routes and a future judge-demo service:
// call `checkHostedRateLimit(ip)` and return 429 when `allowed` is false.
// ---------------------------------------------------------------------------

export const HOSTED_RATE_LIMIT_MAX_REQUESTS = 60;
export const HOSTED_RATE_LIMIT_WINDOW_MS = 60_000;

const hostedRateBuckets = new Map<string, { count: number; resetAt: number }>();

export function resetHostedRateLimitsForTesting(): void {
  hostedRateBuckets.clear();
}

export function checkHostedRateLimit(
  ip: string,
  now: number = Date.now(),
  options: { maxRequests?: number; windowMs?: number } = {}
): { allowed: boolean; retryAfterMs: number } {
  const maxRequests = options.maxRequests ?? HOSTED_RATE_LIMIT_MAX_REQUESTS;
  const windowMs = options.windowMs ?? HOSTED_RATE_LIMIT_WINDOW_MS;
  const key = (ip || "unknown").trim().toLowerCase() || "unknown";
  const bucket = hostedRateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    hostedRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count < maxRequests) {
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
}

/** Extracts the client IP for rate limiting (honours common proxy headers). */
export function getClientIpForRateLimit(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Hosted search provider policy: keyless / self-hosted providers are disabled.
// `duckduckgo` (keyless) and `searxng` (self-hosted) are rejected in
// hosted-demo mode; keyed providers (exa, tavily, brave, gemini-native) and
// `none` remain allowed. URL-level validation in validateSearchBaseUrl is
// unchanged for backwards compatibility.
// ---------------------------------------------------------------------------

export const HOSTED_ALLOWED_SEARCH_PROVIDERS: readonly string[] = [
  "exa",
  "tavily",
  "brave",
  "gemini-native",
  "none"
] as const;

export const HOSTED_BLOCKED_SEARCH_PROVIDERS: readonly string[] = ["duckduckgo", "searxng"] as const;

export function isHostedSearchProviderAllowed(
  provider: string | undefined,
  mode: DeploymentMode = getDeploymentMode()
): boolean {
  if (mode === "local") return true;
  if (!provider || provider.trim() === "") return true;
  return (HOSTED_ALLOWED_SEARCH_PROVIDERS as readonly string[]).includes(provider.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Hosted chat payload limits (shared by /api/chat and /api/chat/compact).
// ---------------------------------------------------------------------------

export const HOSTED_CHAT_MAX_BODY_BYTES = 1024 * 1024;
export const HOSTED_CHAT_MAX_MESSAGES = 100;
export const HOSTED_CHAT_MAX_MESSAGE_CHARS = 100_000;

export function checkChatPayloadSize(body: unknown): { allowed: boolean; reason?: string } {
  let serialized: string;
  try {
    serialized = JSON.stringify(body ?? {});
  } catch {
    return { allowed: false, reason: "Request body is not serializable." };
  }
  if (serialized.length > HOSTED_CHAT_MAX_BODY_BYTES) {
    return {
      allowed: false,
      reason: `Request body exceeds ${HOSTED_CHAT_MAX_BODY_BYTES} bytes.`
    };
  }
  const messages = (body as { messages?: unknown })?.messages;
  if (Array.isArray(messages)) {
    if (messages.length > HOSTED_CHAT_MAX_MESSAGES) {
      return {
        allowed: false,
        reason: `Too many messages (${messages.length} > ${HOSTED_CHAT_MAX_MESSAGES}).`
      };
    }
    for (const m of messages) {
      const text =
        (m as { content?: unknown })?.content ??
        JSON.stringify((m as { parts?: unknown })?.parts ?? "");
      if (typeof text === "string" && text.length > HOSTED_CHAT_MAX_MESSAGE_CHARS) {
        return {
          allowed: false,
          reason: `A message exceeds ${HOSTED_CHAT_MAX_MESSAGE_CHARS} characters.`
        };
      }
    }
  }
  return { allowed: true };
}

/**
 * Shared SSRF and network security validator for outbound HTTP requests in hosted mode.
 * Strictly enforces HTTPS, standard port 443, no embedded credentials, and rejects
 * localhost, RFC1918 private IPs, link-local IPs, cloud metadata endpoints (169.254.x),
 * and optionally validates against approved domain allowlists.
 */
export function validateUrlAgainstSsrf(
  url: string,
  options?: {
    allowedDomains?: readonly string[];
    allowedBaseUrls?: readonly string[];
    domainDescription?: string;
    protocolErrorReason?: string;
    credentialsErrorReason?: string;
  }
): { allowed: boolean; reason?: string } {
  try {
    const raw = url.trim();
    if (!/^https:\/\//i.test(raw)) {
      return {
        allowed: false,
        reason: options?.protocolErrorReason ?? "In hosted-demo mode, only secure HTTPS protocols are permitted."
      };
    }

    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      return {
        allowed: false,
        reason: options?.protocolErrorReason ?? "In hosted-demo mode, only secure HTTPS protocols are permitted."
      };
    }

    if (parsed.username || parsed.password) {
      return {
        allowed: false,
        reason: options?.credentialsErrorReason ?? "Endpoint URLs must not contain embedded user credentials."
      };
    }

    if (parsed.port && parsed.port !== "443") {
      return { allowed: false, reason: `Custom port "${parsed.port}" is not allowed in hosted-demo mode.` };
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

    // Reject localhost, loopbacks, internal IPs, cloud metadata
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    ) {
      return { allowed: false, reason: "Access to private or internal addresses is strictly forbidden." };
    }

    if (options?.allowedDomains || options?.allowedBaseUrls) {
      const allowedDomains = options.allowedDomains ?? [];
      const allowedBaseUrls = options.allowedBaseUrls ?? [];

      const isWhitelisted =
        allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) ||
        allowedBaseUrls.some((allowed) => {
          try {
            const allowedParsed = new URL(allowed);
            return hostname === allowedParsed.hostname || hostname.endsWith(`.${allowedParsed.hostname}`);
          } catch {
            return false;
          }
        });

      if (!isWhitelisted) {
        const desc = options.domainDescription ?? "provider";
        return {
          allowed: false,
          reason: `Host "${hostname}" is not an authorized ${desc} domain in hosted-demo mode.`
        };
      }
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Malformed endpoint URL." };
  }
}

/**
 * Validates whether an LLM provider baseUrl is permitted.
 * In local mode: permits any valid URL or empty string.
 * In hosted-demo mode: permits empty/undefined (default endpoints) or explicit HTTPS allowlisted domains,
 * strictly rejecting localhost, private RFC1918 IPs, cloud IMDS (169.254.x), and unknown hosts.
 */
export function validateChatProviderUrl(
  url: string | undefined,
  mode: DeploymentMode = getDeploymentMode()
): { allowed: boolean; reason?: string } {
  if (mode === "local") {
    if (!url || url.trim() === "") return { allowed: true };
    try {
      new URL(url.startsWith("http://") || url.startsWith("https://") ? url : `http://${url}`);
      return { allowed: true };
    } catch {
      return { allowed: false, reason: `Invalid URL format "${url}".` };
    }
  }

  if (!url || url.trim() === "") {
    return { allowed: true };
  }

  return validateUrlAgainstSsrf(url, {
    allowedDomains: ALLOWED_HOSTED_PROVIDER_DOMAINS,
    allowedBaseUrls: ALLOWED_CHAT_BASE_URLS,
    domainDescription: "LLM provider",
    credentialsErrorReason: "Provider URLs must not contain embedded user credentials."
  });
}

/**
 * Validates whether a search endpoint baseUrl is permitted.
 * In local mode: permits any valid URL or empty string.
 * In hosted-demo mode: permits empty/undefined (default endpoints) or explicit HTTPS allowlisted search domains,
 * strictly rejecting localhost, private RFC1918 IPs, cloud IMDS (169.254.x), unapproved domains, and custom ports.
 */
export function validateSearchBaseUrl(
  url: string | undefined,
  mode: DeploymentMode = getDeploymentMode()
): { allowed: boolean; reason?: string } {
  if (mode === "local") {
    if (!url || url.trim() === "") return { allowed: true };
    try {
      new URL(url.startsWith("http://") || url.startsWith("https://") ? url : `http://${url}`);
      return { allowed: true };
    } catch {
      return { allowed: false, reason: `Invalid URL format "${url}".` };
    }
  }

  if (!url || url.trim() === "") {
    return { allowed: true };
  }

  return validateUrlAgainstSsrf(url, {
    allowedDomains: ALLOWED_SEARCH_PROVIDER_DOMAINS,
    allowedBaseUrls: ALLOWED_SEARCH_BASE_URLS,
    domainDescription: "search provider",
    protocolErrorReason: "In hosted-demo mode, only secure HTTPS search endpoints are permitted.",
    credentialsErrorReason: "Search endpoint URLs must not contain embedded user credentials."
  });
}

/**
 * Returns supported market metadata without exposing scraper configuration.
 */
export function getSupportedMarkets(): MarketMetadata[] {
  return [...STANDARD_MARKETS];
}
