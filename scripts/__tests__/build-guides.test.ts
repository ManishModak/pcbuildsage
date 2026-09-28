/**
 * scripts/__tests__/build-guides.test.ts
 *
 * Unit tests for the budget-picker/skip logic, totals, slugs, the
 * prefill-URL contract, and the no-network guarantee of
 * scripts/build-guides.ts. No catalog DB or scraping required.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUDGET_TIERS,
  customiseUrl,
  describeFilters,
  escapeHtml,
  guideSlug,
  guideTitle,
  guideTotal,
  pickBuildForBudget
} from "../build-guides";

describe("budget tiers", () => {
  it("covers 1080p from 30k to 1L in 10k steps plus 1440p from 70k", () => {
    const tiers = BUDGET_TIERS.map((tier) => `${tier.resolution}:${tier.budget}`);
    expect(tiers).toEqual([
      "1080p:30000",
      "1080p:40000",
      "1080p:50000",
      "1080p:60000",
      "1080p:70000",
      "1080p:80000",
      "1080p:90000",
      "1080p:100000",
      "1440p:70000",
      "1440p:80000",
      "1440p:90000",
      "1440p:100000"
    ]);
  });

  it("gives every tier a search plan for all 8 build categories", () => {
    for (const tier of BUDGET_TIERS) {
      expect(Object.keys(tier.plan).sort()).toEqual(
        ["case", "cooler", "cpu", "gpu", "motherboard", "psu", "ram", "storage"].sort()
      );
    }
  });
});

describe("pickBuildForBudget", () => {
  const builds = [
    { total: 55000, unverified: 0 },
    { total: 45000, unverified: 2 },
    { total: 48000, unverified: 1 }
  ];

  it("returns null (skip) when no candidate list is given", () => {
    expect(pickBuildForBudget([], 100000)).toBeNull();
  });

  it("returns null (skip) for an impossibly low budget", () => {
    expect(pickBuildForBudget(builds, 1000)).toBeNull();
  });

  it("skips over-budget builds even when they are otherwise valid", () => {
    const picked = pickBuildForBudget(builds, 50000);
    expect(picked).not.toBeNull();
    expect(picked!.total).toBeLessThanOrEqual(50000);
  });

  it("prefers fewest unverified specs, then lowest total", () => {
    expect(pickBuildForBudget(builds, 100000)).toEqual({ total: 55000, unverified: 0 });
    expect(pickBuildForBudget([{ total: 40000, unverified: 1 }, { total: 45000, unverified: 0 }], 100000)).toEqual({
      total: 45000,
      unverified: 0
    });
    expect(pickBuildForBudget([{ total: 40000, unverified: 0 }, { total: 35000, unverified: 0 }], 100000)).toEqual({
      total: 35000,
      unverified: 0
    });
  });

  it("ignores unpriced (null-total) candidates", () => {
    expect(pickBuildForBudget([{ total: null, unverified: 0 }, ...builds], 100000)).toEqual({
      total: 55000,
      unverified: 0
    });
    expect(pickBuildForBudget([{ total: null, unverified: 0 }], 100000)).toBeNull();
  });
});

describe("guideTotal", () => {
  it("equals the sum of part prices", () => {
    expect(guideTotal([{ price: 12000 }, { price: 8000.5 }, { price: 0 }])).toBeCloseTo(20000.5, 9);
  });

  it("is null when any part is unpriced or the list is empty", () => {
    expect(guideTotal([{ price: 12000 }, { price: null }])).toBeNull();
    expect(guideTotal([{ price: 12000 }, {}])).toBeNull();
    expect(guideTotal([])).toBeNull();
  });
});

describe("describeFilters", () => {
  it("prefers the search term, else summarizes filters", () => {
    expect(describeFilters("cpu", { term: "Ryzen 5 5600" })).toBe("Ryzen 5 5600");
    expect(describeFilters("ram", { ddr: "DDR4", min_capacity_gb: 16, modules: 2 })).toBe("DDR4 16GB+ ram");
    expect(describeFilters("psu", { min_wattage: 650, term: "Bronze" })).toBe("Bronze");
    expect(describeFilters("case", {})).toBe("case");
  });
});

describe("slugs, titles, escaping", () => {
  it("builds stable page slugs", () => {
    expect(guideSlug({ budget: 60000, resolution: "1080p" })).toBe("gaming-1080p-under-60000");
    expect(guideSlug({ budget: 100000, resolution: "1440p" })).toBe("gaming-1440p-under-100000");
  });

  it("titles never use the word 'best'", () => {
    for (const tier of BUDGET_TIERS) {
      expect(guideTitle(tier).toLowerCase()).not.toContain("best");
    }
  });

  it("escapes HTML special chars", () => {
    expect(escapeHtml(`<a href="x">&'test'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;test&#39;&lt;/a&gt;"
    );
  });
});

describe("prefill-URL contract", () => {
  it("emits a demo link with the request in ?prompt=", () => {
    const url = customiseUrl({ budget: 60000, resolution: "1080p" }, "cpu: Ryzen 5 5600");
    expect(url.startsWith("https://pcbuildsage.onrender.com?prompt=")).toBe(true);
    const decoded = decodeURIComponent(url.split("?prompt=")[1]);
    expect(decoded).toContain("60000");
    expect(decoded).toContain("1080p");
    expect(decoded).toContain("Ryzen 5 5600");
  });
});

describe("no-network guarantee", () => {
  it("the guide script makes no network calls", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts", "build-guides.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest/);
    expect(source).not.toMatch(/\bfrom\s+["']node:https?["']/);
    expect(source).not.toMatch(/\bfrom\s+["'](axios|node-fetch|undici)["']/);
  });
});
