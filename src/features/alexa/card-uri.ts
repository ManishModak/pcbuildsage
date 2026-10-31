/**
 * src/features/alexa/card-uri.ts
 *
 * Client-safe copy of the build card resource URI. This MUST match
 * BUILD_CARD_URI in src/lib/mcp/build-card.ts (read-only, shared with
 * Track A — do not edit it to fix a drift here). It is duplicated rather
 * than imported because that module pulls in node:fs/node:path, which cannot
 * ship in this client component's bundle.
 */
export const BUILD_CARD_URI_FALLBACK = "ui://pcbuildsage/build-card";
