/**
 * scripts/__tests__/build-guides.test.ts
 *
 * Unit tests for the budget-picker/skip logic, totals, slugs, the
 * prefill-URL contract, and the no-network guarantee of
 * scripts/build-guides.ts. No scraping; the one end-to-end run uses a temp
 * copy of the tiny data/products-sample.db, never the real catalog.
 */

import { describe, it, expect, vi } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import path from "node:path";
import {
  BUDGET_TIERS,
  CANDIDATES_PER_CATEGORY,
  CATEGORIES,
  MAX_COMBOS,
  NO_FALLBACK_CATEGORIES,
  customiseUrl,
  describeFilters,
  escapeHtml,
  formatIst,
  guideSlug,
  guideTitle,
  guideTotal,
  pickBuildForBudget,
  renderHelpPage,
  GPU_LADDER,
  MIN_GPU_CLASS,
  runBuildGuides,
  tierPlan
} from "../build-guides";
import {
  API_KEY_FAQS,
  API_KEY_FACTS,
  API_KEY_GUIDES,
  FREE_LIMIT_COPY,
  KEY_REJECTED_COPY
} from "../../src/content/api-key-help";

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

  it("gives every tier a search plan for the 7 non-GPU categories plus GPU classes", () => {
    for (const tier of BUDGET_TIERS) {
      expect(Object.keys(tier.plan).sort()).toEqual(
        ["case", "cooler", "cpu", "motherboard", "psu", "ram", "storage"].sort()
      );
      expect(tier.gpuClasses.length).toBeGreaterThan(0);
    }
  });
});

describe("1440p tiers", () => {
  it("take the CPU one step down and require a stronger minimum GPU than 1080p", () => {
    for (const budget of [70000, 80000, 90000, 100000]) {
      const p1080 = BUDGET_TIERS.find((t) => t.budget === budget && t.resolution === "1080p")!;
      const p1440 = BUDGET_TIERS.find((t) => t.budget === budget && t.resolution === "1440p")!;
      expect(p1440.gpuClasses[0]).toBe(MIN_GPU_CLASS["1440p"]);
      expect(GPU_LADDER.indexOf(MIN_GPU_CLASS["1440p"])).toBeGreaterThan(GPU_LADDER.indexOf(p1080.gpuClasses[0] as never));
    }
    expect(tierPlan(90000, "1440p").cpu.term).toBe("Ryzen 5 5500");
    expect(tierPlan(90000, "1080p").cpu.term).toBe("Ryzen 5 5600");
  });
});

describe("candidate search", () => {
  it("never falls back to the cheapest CPU or GPU, only commodity parts", () => {
    expect([...NO_FALLBACK_CATEGORIES].sort()).toEqual(["cpu", "gpu"]);
  });

  it("tries the full combination space (fits under MAX_COMBOS)", () => {
    const space = CATEGORIES.reduce((product, category) => product * CANDIDATES_PER_CATEGORY[category], 1);
    expect(space).toBeLessThanOrEqual(MAX_COMBOS);
  });
});

describe("formatIst", () => {
  it("formats catalog scrape times in IST", () => {
    expect(formatIst("2026-09-28T08:54:00Z")).toBe("28 Sep 2026, 2:24 pm IST");
    expect(formatIst("2026-09-27T18:30:00Z")).toBe("28 Sep 2026, 12:00 am IST");
    expect(formatIst("not a date")).toBe("not a date");
  });
});

/** Temp catalog DB: the sample DB's schema, holding only `rows`. */
function tempCatalog(rows: Array<Record<string, unknown>>): { dir: string; db: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "guides-"));
  const db = path.join(dir, "catalog.db");
  copyFileSync(path.join(process.cwd(), "data", "products-sample.db"), db);
  if (rows.length > 0) {
    const sqlite = new Database(db);
    sqlite.prepare("DELETE FROM products").run();
    const columns = Object.keys(rows[0]);
    const insert = sqlite.prepare(
      `INSERT INTO products (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`
    );
    for (const row of rows) insert.run(row);
    sqlite.close();
  }
  return { dir, db };
}

async function runQuietly(args: string[]) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await runBuildGuides(args);
  } finally {
    vi.restoreAllMocks();
  }
}

describe("runBuildGuides end to end", () => {
  it("publishes realistic tiers from a small real-listing fixture", async () => {
    // 23 in-stock listings copied from a 2026-09-28 India catalog, where RAM
    // is expensive (16GB DDR4 kit ₹14,000), so the low budgets can't fit.
    const fixture = JSON.parse(
      readFileSync(path.join(process.cwd(), "scripts", "__tests__", "fixtures", "guides-catalog.json"), "utf8")
    ) as Array<Record<string, unknown>>;
    const { dir, db } = tempCatalog(fixture);
    const out = path.join(dir, "site");
    try {
      const result = await runQuietly(["--db", db, "--out", out]);
      expect(result.exitCode).toBe(0);
      const slugs = result.published.map((guide) => guide.slug);
      expect(slugs).toContain("gaming-1080p-under-90000");
      expect(slugs).toContain("gaming-1440p-under-90000");
      for (const guide of result.published) {
        expect(guide.total).toBeLessThanOrEqual(guide.tier.budget);
        expect(existsSync(path.join(out, `${guide.slug}.html`))).toBe(true);
      }
      expect(result.skipped.some((reason) => reason.startsWith("gaming-1080p-under-30000"))).toBe(true);
      // The 1440p page beats the 1080p page's GPU at the same budget.
      const html1440 = readFileSync(path.join(out, "gaming-1440p-under-90000.html"), "utf8");
      expect(html1440).toContain("RTX 5060 Ti");
      expect(html1440).toContain("prices checked 28 Sep 2026");
      expect(existsSync(path.join(out, "index.html"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits 1 and writes nothing when no tier publishes, so Pages keeps the last deploy", async () => {
    // The tiny sample catalog has no AM4 CPU matching any tier term.
    const { dir, db } = tempCatalog([]);
    const out = path.join(dir, "site");
    try {
      const result = await runQuietly(["--db", db, "--out", out]);
      expect(result.exitCode).toBe(1);
      expect(result.published).toHaveLength(0);
      expect(result.skipped).toHaveLength(BUDGET_TIERS.length);
      expect(result.skipped.every((reason) => /no in-stock cpu matching/.test(reason))).toBe(true);
      expect(existsSync(path.join(out, "index.html"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

describe("M2: Pages /help/api-key mirror", () => {
  it("renders every guide, fact, FAQ and error string from the shared content module", () => {
    const html = renderHelpPage();
    for (const guide of API_KEY_GUIDES) {
      expect(html).toContain(escapeHtml(guide.title));
      for (const step of guide.steps) expect(html).toContain(escapeHtml(step.text));
    }
    for (const fact of API_KEY_FACTS) {
      expect(html).toContain(escapeHtml(fact.heading));
      expect(html).toContain(escapeHtml(fact.text));
    }
    for (const faq of API_KEY_FAQS) {
      expect(html).toContain(escapeHtml(faq.question));
      expect(html).toContain(escapeHtml(faq.answer));
    }
    expect(html).toContain(escapeHtml(KEY_REJECTED_COPY));
    expect(html).toContain(escapeHtml(FREE_LIMIT_COPY));
    expect(html.toLowerCase()).not.toContain("best");
  });
});
