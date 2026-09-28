/**
 * src/middleware.ts
 *
 * Next.js Edge / Request Middleware for dual-mode deployment route guarding.
 * Allows only explicitly listed public `/api` routes in hosted-demo mode
 * (default-deny), and cross-site or non-loopback requests in local mode.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  checkHostedRateLimit,
  getClientIpForRateLimit,
  isHostedDemo,
  isHostedSearchProviderAllowed,
  isRouteAllowedInHostedMode
} from "@/lib/config/deployment";
import { allowedHostsFromEnv, localRequestRejection } from "@/lib/middleware/local-request-guard";

export function middleware(request: NextRequest) {
  if (!isHostedDemo()) {
    const reason = localRequestRejection(request.headers, allowedHostsFromEnv(), request.nextUrl.host);
    if (reason) {
      return NextResponse.json({ error: reason, message: reason, code: "LOCAL_REQUEST_FORBIDDEN" }, { status: 403 });
    }
  }

  if (isHostedDemo()) {
    const pathname = request.nextUrl.pathname;
    const ip = getClientIpForRateLimit(request.headers);
    const limit = checkHostedRateLimit(ip);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded. Please retry shortly.",
          message: "Rate limit exceeded. Please retry shortly.",
          code: "HOSTED_RATE_LIMITED"
        },
        { status: 429 }
      );
    }
    if (!isRouteAllowedInHostedMode(pathname, request.method)) {
      return NextResponse.json(
        {
          error: "This endpoint is disabled in hosted demo mode",
          message: "This endpoint is disabled in hosted demo mode",
          code: "HOSTED_DEMO_FORBIDDEN"
        },
        { status: 403 }
      );
    }
    // Disable keyless / self-hosted search (DuckDuckGo, SearXNG) in hosted mode.
    const searchProvider = hostedSearchProviderFromHeaders(request.headers);
    if (searchProvider && !isHostedSearchProviderAllowed(searchProvider, "hosted-demo")) {
      return NextResponse.json(
        {
          error: `Search provider '${searchProvider}' is not supported in hosted demo mode`,
          message: `Search provider '${searchProvider}' is not supported in hosted demo mode`,
          code: "HOSTED_DEMO_FORBIDDEN"
        },
        { status: 403 }
      );
    }
  }

  return NextResponse.next();
}

function hostedSearchProviderFromHeaders(headers: Headers): string | null {
  const raw = headers.get("x-pcbuildsage-config");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { searchProvider?: unknown };
    return typeof parsed.searchProvider === "string" ? parsed.searchProvider : null;
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/api/:path*"]
};
