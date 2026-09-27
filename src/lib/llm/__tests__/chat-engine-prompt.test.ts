import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../chat-engine";
import type { AppConfig } from "@/types";

// These tests pin the presence of guidance concepts, not exact prose: rewording
// a paragraph must not break them, and passing them proves nothing about model
// behavior — only that the instruction is still in the prompt.
describe("chat-engine system prompt guidance (Issues 05, 03, 08)", () => {
  const dummyConfig: AppConfig = {
    dbPath: ":memory:",
    theme: "default",
    countryCode: "IN",
    currency: "INR",
    personality: "balanced",
    tier2Enabled: false,
    freeformConsultEnabled: false,
    llm: {
      chain: [{ provider: "gemini", model: "mock-model", keySource: "env" }],
      roles: {
        chat: [{ provider: "gemini", model: "mock-model", keySource: "env" }],
        subagent: [{ provider: "gemini", model: "mock-model", keySource: "env" }],
        scraper: [{ provider: "gemini", model: "mock-model", keySource: "env" }]
      }
    },
    search: {
      provider: "none",
      crawlEnabled: false
    }
  };

  /** Asserts one prompt line carries every marker word (case-insensitive). */
  function expectGuidance(prompt: string, ...markers: string[]) {
    const lines = prompt.split("\n");
    const found = lines.some((line) =>
      markers.every((marker) => line.toLowerCase().includes(marker.toLowerCase()))
    );
    expect(found, `expected guidance covering: ${markers.join(" + ")}`).toBe(true);
  }

  it("grounds recommendation claims in evidence, not superlatives", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "'fastest'", "performance data");
    expectGuidance(prompt, "limit comparisons");
  });

  it("allows direct recommendations stating 'my recommended choice'", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "my recommended choice");
  });

  it("includes updated search workflow guidance without get_catalog", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "list_models", "search_products");
    expect(prompt).not.toContain("get_catalog");
  });

  it("does not instruct highest-price-first (order: 'desc') searching", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).not.toContain("order: 'desc'");
  });

  it("does not contain the raw filter list in the prompt", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).not.toContain("filters include category, subcategory");
    expect(prompt).not.toContain("min_gpu_clearance_mm, min_cooler_clearance_mm, sort_by");
  });

  it("includes case clearance guidance using min_gpu_clearance_mm and min_cooler_clearance_mm", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "min_gpu_clearance_mm", "min_cooler_clearance_mm");
  });

  it("includes CPU cooler guidance for stock cooler vs unknown cooler", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "stock cooler", "no additional cost");
    expectGuidance(prompt, "skip the [price] cooler");
  });

  it("requires validation before presentation and presents alternatives together", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "compatibility checks", "present_build");
    expectGuidance(prompt, "alternatives together");
  });

  it("guides offering 3 builds up to 5 with recommended build first", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "usually offer 3 builds", "up to 5");
    expectGuidance(prompt, "recommended build first");
  });

  it("guides budget overrun of 2-3% only for clear value jump while keeping a within-budget option", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "strict cap", "small margin (about 2–3%)", "clear value jump");
    expectGuidance(prompt, "exact extra amount");
    expectGuidance(prompt, "never describe an over-budget build as within budget");
    expectGuidance(prompt, "Within budget");
    expectGuidance(prompt, "4060", "4070");
  });

  it("uses workload-neutral wording rather than assuming gaming", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain("prioritise the parts that matter for the user's stated workload");
    expect(prompt).toContain("expected performance for that workload");
    expect(prompt).not.toContain("prioritize the GPU and CPU for gaming");
    expect(prompt).not.toContain("expected gaming performance");
  });

  it("asserts every behaviour rule appears exactly once", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    const lines = prompt.split("\n");

    // Data trust
    const dataTrustLines = lines.filter((l) => l.includes("Trust catalog data:"));
    expect(dataTrustLines).toHaveLength(1);

    // No invented specs
    const noInventedLines = lines.filter((l) => l.includes("do not guess or invent specs"));
    expect(noInventedLines).toHaveLength(1);

    // Skipped checks
    const skippedChecksLines = lines.filter((l) => l.includes("skipped_checks"));
    expect(skippedChecksLines).toHaveLength(1);

    // Budget guidance
    const budgetLines = lines.filter((l) => l.startsWith("Budget guidance:"));
    expect(budgetLines).toHaveLength(1);

    // Answer shape
    const answerShapeLines = lines.filter((l) => l.startsWith("Answer shape:"));
    expect(answerShapeLines).toHaveLength(1);

    // Consult disabled duplicate removed (only appears once when tier2Enabled is false)
    const consultDisabledLines = lines.filter(
      (l) => l.toLowerCase().includes("consult") && l.toLowerCase().includes("disabled")
    );
    expect(consultDisabledLines).toHaveLength(1);

    // Plain emphasis: no shouting directives
    expect(prompt).not.toContain("MANDATORY");
    expect(prompt).not.toContain("CRITICAL DIRECTIVE");
    expect(prompt).not.toContain("MUST ALWAYS");
  });

  it("reflects active country and currency in the catalog summary block", () => {
    const catalogIN = {
      categories: [
        { category: "gpu", count: 12, in_stock_count: 10, price_min: 15000, price_max: 80000 },
        { category: "cpu", count: 6, in_stock_count: 6, price_min: 8000, price_max: 30000 },
        {
          category: "storage",
          count: 15,
          in_stock_count: 14,
          price_min: 2000,
          price_max: 15000,
          subcategories: { external: { count: 3, price_min: 3000, price_max: 8000 } }
        }
      ],
      scope: { country_code: "IN", currency: "INR" }
    };
    const catalogUS = {
      categories: [
        { category: "gpu", count: 8, in_stock_count: 7, price_min: 250, price_max: 1200 },
        { category: "cpu", count: 5, in_stock_count: 5, price_min: 100, price_max: 400 }
      ],
      scope: { country_code: "US", currency: "USD" }
    };

    const promptIN = buildSystemPrompt(dummyConfig, catalogIN);
    expect(promptIN).toContain("Catalog summary (IN, INR):");
    expect(promptIN).toContain("- gpu: 12 items (10 in stock), price: ₹15000–₹80000");
    expect(promptIN).toContain("[accessories: external: 3 (₹3000–₹8000)]");

    const promptUS = buildSystemPrompt(
      { ...dummyConfig, countryCode: "US", currency: "USD" },
      catalogUS
    );
    expect(promptUS).toContain("Catalog summary (US, USD):");
    expect(promptUS).toContain("- gpu: 8 items (7 in stock), price: $250–$1200");
  });

  it("uses active currency symbol ($0) and avoids hardcoded INR when currency is USD", () => {
    const usdConfig: AppConfig = {
      ...dummyConfig,
      countryCode: "US",
      currency: "USD"
    };
    const prompt = buildSystemPrompt(usdConfig);
    expectGuidance(prompt, "no additional cost ($0)");
    expectGuidance(prompt, "'Within budget'", "'Small upgrade'");
    expect(prompt).not.toContain("₹");
  });
});
