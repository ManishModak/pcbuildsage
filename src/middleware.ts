/**
 * src/middleware.ts
 *
 * Next.js Edge / Request Middleware for dual-mode deployment route guarding.
 * Allows only explicitly listed public `/api` routes in hosted-demo mode
 * (default-deny) behind a per-IP rate limit, and rejects cross-site or
 * non-loopback requests in local mode. Hosted search-provider policy is
 * enforced per request in assertSafeSearchConfig (api/_lib/credentials.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  checkHostedRateLimit,
  getClientIpForRateLimit,
  isHostedDemo,
  isRateLimitExemptPath,
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
    // /api/health is exempt so Render's health checks never trip (or spend) the limit.
    const limit = isRateLimitExemptPath(pathname)
      ? { allowed: true }
      : checkHostedRateLimit(getClientIpForRateLimit(request.headers));
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
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"]
};
