import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../chat-engine";
import type { AppConfig } from "@/types";

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

  it("includes recommendation claims instruction without claiming fastest/strongest without data", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain(
      "Explain recommendations using available evidence. Don’t claim 'fastest', 'strongest', or 'best-performing' without supporting performance data. When benchmarks are available, limit comparisons to the models and workload covered."
    );
  });

  it("allows direct recommendations stating 'my recommended choice'", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain(
      "Recommendations can directly state 'my recommended choice' and explain the budget, requirements, and documented specifications behind it (e.g. 'I chose this GPU because it fits the budget and leaves room for the other parts')."
    );
  });

  it("includes updated search workflow guidance", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain(
      "For broad build requests: get_catalog → list_models → search_products. Shortlist a few suitable models before looking through their offers. For an exact product or a straightforward filtered purchase request, skip model discovery when direct search is sufficient."
    );
  });

  it("does not instruct highest-price-first (order: 'desc') searching", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).not.toContain("order: 'desc'");
  });

  it("includes case clearance guidance using min_gpu_clearance_mm and min_cooler_clearance_mm", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain(
      "When searching for cases for a selected GPU and cooler, use `min_gpu_clearance_mm` and `min_cooler_clearance_mm`."
    );
  });

  it("includes CPU cooler guidance for stock cooler vs unknown cooler", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain(
      "When a CPU package includes a stock cooler, show it as included with the CPU at no additional cost (₹0). When cooler inclusion is unknown, keep a separate cooler in the build and explain: 'Check whether this CPU package includes a stock cooler. If included and suitable for your use, you can skip the [price] cooler.'"
    );
  });

  it("includes build presentation guidance with compatibility checks before present_build and revised versions", () => {
    const prompt = buildSystemPrompt(dummyConfig);
    expect(prompt).toContain(
      "Finalize component choices and run compatibility checks before calling present_build. Include all intended alternatives together. If a later correction is needed, present a revised version and explain what changed."
    );
  });

  it("uses active currency symbol ($0) and avoids hardcoded INR when currency is USD", () => {
    const usdConfig: AppConfig = {
      ...dummyConfig,
      countryCode: "US",
      currency: "USD"
    };
    const prompt = buildSystemPrompt(usdConfig);
    expect(prompt).toContain(
      "When a CPU package includes a stock cooler, show it as included with the CPU at no additional cost ($0)."
    );
    expect(prompt).not.toContain("₹");
  });
});
