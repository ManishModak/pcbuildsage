/**
 * src/middleware.ts
 *
 * Next.js Edge / Request Middleware for dual-mode deployment route guarding.
 * Rejects requests to blocked administrative/mutating endpoints in hosted-demo mode,
 * and cross-site or non-loopback requests in local mode.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isHostedDemo, isRouteBlockedInHostedMode } from "@/lib/config/deployment";
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
    if (isRouteBlockedInHostedMode(pathname, request.method)) {
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
