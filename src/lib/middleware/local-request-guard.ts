/**
 * src/lib/middleware/local-request-guard.ts
 *
 * Local mode has no login: the API trusts whoever can reach it, and it holds
 * the user's .env keys. This guard limits "whoever" to the user's own tab and
 * local tools:
 * - the Host must be a loopback name, which defeats DNS rebinding;
 * - a browser request must come from this same origin, so another website
 *   can't drive the API (for example an <img> tag hitting /api/models).
 * Non-browser clients (curl, the CLI) send neither Origin nor Sec-Fetch-Site
 * and pass. PCBUILDSAGE_ALLOWED_HOSTS (comma-separated host names) adds hosts
 * for deliberate LAN use.
 */

const SAFE_FETCH_SITES = new Set(["same-origin", "none"]);

/** Host names from PCBUILDSAGE_ALLOWED_HOSTS, lowercased, without ports. */
export function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PCBUILDSAGE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns why a local-mode API request must be refused, or null when it may proceed.
 * `fallbackHost` (the request URL's host) is used only when no Host header was sent.
 */
export function localRequestRejection(
  headers: Headers,
  allowedHosts: readonly string[] = [],
  fallbackHost?: string
): string | null {
  const host = headers.get("host") ?? fallbackHost ?? null;
  const hostname = host ? hostnameOf(host) : null;
  if (!hostname || !(isLoopbackHost(hostname) || allowedHosts.includes(hostname))) {
    return `Host "${host ?? ""}" is not allowed. Open PCBuildSage via http://localhost, or add the host to PCBUILDSAGE_ALLOWED_HOSTS.`;
  }

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite && !SAFE_FETCH_SITES.has(fetchSite.toLowerCase())) {
    return "Cross-site requests to the local API are not allowed.";
  }

  const origin = headers.get("origin");
  if (origin && originHost(origin) !== host!.toLowerCase()) {
    return "Cross-origin requests to the local API are not allowed.";
  }
  return null;
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    // "null" (sandboxed frames, file:// pages) and malformed values never match.
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}
