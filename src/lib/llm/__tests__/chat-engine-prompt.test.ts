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

  it("includes updated search workflow guidance", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "get_catalog", "list_models", "search_products");
  });

  it("does not instruct highest-price-first (order: 'desc') searching", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).not.toContain("order: 'desc'");
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

  it("guides 2-3 meaningful build options without forcing specific briefs into a single build", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "2-3 meaningful build options");
    expectGuidance(prompt, "rather than forcing a single build");
    expect(prompt).not.toContain("If the user's brief is specific, propose 1 complete build.");
  });

  it("guides modest overruns with disclosure even for strict budgets while retaining a viable within-cap build", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expectGuidance(prompt, "strict cap", "within the stated cap");
    expectGuidance(prompt, "modest overrun");
    expectGuidance(prompt, "never describe an over-budget option as within budget");
    expectGuidance(prompt, "'Within budget'", "'Small upgrade'");
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
