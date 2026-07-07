import { describe, expect, it } from "vitest";
import fixture from "../../../data/fixtures/sha1-urls.json" with { type: "json" };
import { sha1 } from "../product-id";

describe("sha1 product ids", () => {
  it("matches the shared scraper fixture for every URL", () => {
    for (const entry of fixture) {
      expect(sha1(entry.url)).toBe(entry.sha1);
    }
  });
});
