/**
 * src/middleware.ts
 *
 * Next.js Edge / Request Middleware for dual-mode deployment route guarding.
 * Rejects requests to blocked administrative/mutating endpoints in hosted-demo mode.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isHostedDemo, isRouteBlockedInHostedMode } from "@/lib/config/deployment";

export function middleware(request: NextRequest) {
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
