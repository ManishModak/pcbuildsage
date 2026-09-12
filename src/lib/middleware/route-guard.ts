/**
 * src/lib/middleware/route-guard.ts
 *
 * Handler-level route protection for hosted-demo mode.
 * Provides defense-in-depth within route handlers.
 */

import { json } from "@/app/api/_lib/responses";
import { isHostedDemo } from "@/lib/config/deployment";

export function createForbiddenResponse(
  message = "This endpoint is disabled in hosted demo mode",
  customPayload?: Record<string, unknown>
): Response {
  return json(
    customPayload ?? {
      error: message,
      message,
      code: "HOSTED_DEMO_FORBIDDEN"
    },
    { status: 403 }
  );
}

export function guardHostedRoute(
  request?: Request,
  options?: { message?: string; customPayload?: Record<string, unknown> }
): Response | null {
  void request;
  if (isHostedDemo()) {
    return createForbiddenResponse(options?.message, options?.customPayload);
  }
  return null;
}
