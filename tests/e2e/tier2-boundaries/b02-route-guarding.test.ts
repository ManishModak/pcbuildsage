import { describe, it, expect } from "vitest";
import { isRouteBlocked } from "../test-harness";

describe("Tier 2 Boundary - Feature 2: Route Guarding Edge Cases", () => {
  it("blocks URL-encoded bypass attempts (e.g. /api/%73crape)", () => {
    expect(isRouteBlocked("/api/%73crape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/%70rofiles", "GET", "hosted-demo")).toBe(true);
  });

  it("blocks paths with multiple trailing slashes or subpaths (e.g. /api/scrape///)", () => {
    expect(isRouteBlocked("/api/scrape///", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/profiles/subpath/item", "GET", "hosted-demo")).toBe(true);
  });

  it("blocks dangerous routes across all non-standard and HTTP mutation methods", () => {
    expect(isRouteBlocked("/api/scrape", "PUT", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/scrape", "DELETE", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/profiles", "DELETE", "hosted-demo")).toBe(true);
  });

  it("allows safe routes even with query parameters attached (e.g. /api/markets?refresh=true)", () => {
    expect(isRouteBlocked("/api/markets?country=US", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlocked("/api/status?details=true", "GET", "hosted-demo")).toBe(false);
  });

  it("allows arbitrary routes in local mode without restriction", () => {
    expect(isRouteBlocked("/api/scrape", "POST", "local")).toBe(false);
    expect(isRouteBlocked("/api/%73crape", "POST", "local")).toBe(false);
  });
});
