import { describe, it, expect } from "vitest";
import { isRouteBlocked } from "../test-harness";

describe("Tier 1 - Feature 2: Route Guarding Middleware (R1)", () => {
  it("blocks POST /api/scrape in hosted-demo mode", () => {
    expect(isRouteBlocked("/api/scrape", "POST", "hosted-demo")).toBe(true);
  });

  it("blocks POST /api/profiles/import and POST /api/profiles/test in hosted-demo mode", () => {
    expect(isRouteBlocked("/api/profiles/import", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/profiles/test", "POST", "hosted-demo")).toBe(true);
  });

  it("blocks GET /api/profiles and GET /api/logs in hosted-demo mode", () => {
    expect(isRouteBlocked("/api/profiles", "GET", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/logs", "GET", "hosted-demo")).toBe(true);
  });

  it("permits public routes /api/health, /api/markets, /api/status, and /api/chat in hosted-demo mode", () => {
    expect(isRouteBlocked("/api/health", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlocked("/api/markets", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlocked("/api/status", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlocked("/api/chat", "POST", "hosted-demo")).toBe(false);
  });

  it("permits all routes in local deployment mode", () => {
    expect(isRouteBlocked("/api/scrape", "POST", "local")).toBe(false);
    expect(isRouteBlocked("/api/profiles", "GET", "local")).toBe(false);
    expect(isRouteBlocked("/api/profiles/import", "POST", "local")).toBe(false);
    expect(isRouteBlocked("/api/profiles/test", "POST", "local")).toBe(false);
    expect(isRouteBlocked("/api/logs", "GET", "local")).toBe(false);
    expect(isRouteBlocked("/api/health", "GET", "local")).toBe(false);
  });
});
