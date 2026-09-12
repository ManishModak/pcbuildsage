import { describe, expect, it } from "vitest";
import {
  estimateScrapeMinutes,
  formatClock,
  formatLatency,
  formatPrice,
  formatRelativeTime,
  minorDigits,
  sumPrices,
  titleCase,
  getErrorMessage,
  getErrorMessageText,
  formatModelName,
  formatStarterBudget
} from "../format";

import { pickTheme, resolveTheme, TOKEN_KEYS } from "../theme";
import type { ThemeFile } from "@/types/client";

describe("formatPrice", () => {
  it("renders INR minor units with two fraction digits", () => {
    expect(formatPrice(24999, "INR", "en-IN")).toMatch(/24,999\.00/);
  });

  it("renders zero-decimal currencies without fraction digits", () => {
    expect(minorDigits("JPY")).toBe(0);
    expect(formatPrice(15000, "JPY", "en-US")).toMatch(/15,000/);
    expect(formatPrice(15000, "JPY", "en-US")).not.toMatch(/\./);
  });

  it("returns an em dash for missing prices", () => {
    expect(formatPrice(null, "USD")).toBe("—");
    expect(formatPrice(undefined, "USD")).toBe("—");
  });

  it("falls back gracefully for unknown currency codes", () => {
    expect(formatPrice(1000, "ZZZ", "en-US")).toContain("ZZZ");
  });
});

describe("sumPrices", () => {
  it("ignores null and undefined entries", () => {
    expect(sumPrices([100, null, 200, undefined, 50])).toBe(350);
  });
});

describe("formatLatency", () => {
  it("uses ms under a second and seconds above", () => {
    expect(formatLatency(420)).toBe("420ms");
    expect(formatLatency(1500)).toBe("1.50s");
    expect(formatLatency(undefined)).toBe("—");
  });
});

describe("estimateScrapeMinutes", () => {
  it("labels sub-minute crawls in seconds", () => {
    expect(estimateScrapeMinutes(1, 2, 1000).label).toMatch(/sec/);
  });
  it("labels longer crawls in minutes", () => {
    expect(estimateScrapeMinutes(20, 40, 1000).label).toMatch(/min/);
  });
  it("factors in concurrency and site count to reduce estimated time", () => {
    const single = estimateScrapeMinutes(20, 100, 1000, 1, 4);
    const multi = estimateScrapeMinutes(20, 100, 1000, 4, 4);
    expect(single.label).toBe("~6 min");
    expect(multi.label).toBe("~1 min");
  });
});

describe("theme resolution", () => {
  const light: ThemeFile = {
    id: "sage-light",
    theme_name: "sage-light",
    mode: "light",
    tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, "#ffffff"]))
  };

  it("resolves every token key", () => {
    const resolved = resolveTheme(light);
    for (const key of TOKEN_KEYS) expect(resolved.tokens[key]).toBeTruthy();
    expect(resolved.mode).toBe("light");
  });

  it("fills missing tokens from the sage-dark fallback", () => {
    const partial: ThemeFile = { id: "partial", tokens: { "--bg": "#000000" } };
    const resolved = resolveTheme(partial);
    expect(resolved.tokens["--bg"]).toBe("#000000");
    expect(resolved.tokens["--accent"]).toBe("#7DC383");
  });

  it("picks a named theme when present", () => {
    expect(pickTheme([light], "sage-light").name).toBe("sage-light");
  });
});

describe("minorDigits", () => {
  it("is case-insensitive and defaults unknown currencies to two digits", () => {
    expect(minorDigits("INR")).toBe(2);
    expect(minorDigits("jpy")).toBe(0);
    expect(minorDigits("krw")).toBe(0);
    expect(minorDigits("ZZZ")).toBe(2);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
  const shift = (seconds: number) => new Date(now + seconds * 1000).toISOString();

  it("returns an em dash for missing or invalid input", () => {
    expect(formatRelativeTime(undefined, now)).toBe("—");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });

  it("formats past times in seconds, minutes, hours, and days", () => {
    expect(formatRelativeTime(shift(-30), now)).toBe("30 seconds ago");
    expect(formatRelativeTime(shift(-5 * 60), now)).toBe("5 minutes ago");
    expect(formatRelativeTime(shift(-2 * 3600), now)).toBe("2 hours ago");
    expect(formatRelativeTime(shift(-3 * 86400), now)).toBe("3 days ago");
  });

  it("formats future times", () => {
    expect(formatRelativeTime(shift(45), now)).toBe("in 45 seconds");
    expect(formatRelativeTime(shift(10 * 60), now)).toBe("in 10 minutes");
  });

  it("handles a sub-second difference via the second fallback", () => {
    expect(formatRelativeTime(shift(0), now)).toBe("now");
  });
});

describe("formatClock", () => {
  const now = new Date(2026, 2, 15, 12, 0, 0).getTime();

  it("shows time only for a same-day timestamp", () => {
    const sameDay = formatClock(new Date(2026, 2, 15, 9, 30, 0).toISOString(), now);
    expect(sameDay).toMatch(/0?9:30/);
    expect(sameDay).not.toMatch(/[A-Za-z]{3,}/); // no month name
  });

  it("includes month and day for a different-day timestamp", () => {
    const otherDay = formatClock(new Date(2026, 2, 12, 9, 30, 0).toISOString(), now);
    expect(otherDay).toMatch(/0?9:30/);
    expect(otherDay).toMatch(/12/); // day of month
    expect(otherDay).toMatch(/[A-Za-z]{3,}/); // month name
  });

  it("returns an empty string for invalid input", () => {
    expect(formatClock("not-a-date", now)).toBe("");
  });
});

describe("titleCase", () => {
  it("converts dashes and underscores to spaces and capitalizes words", () => {
    expect(titleCase("balanced-showpiece")).toBe("Balanced Showpiece");
    expect(titleCase("quiet_small_form")).toBe("Quiet Small Form");
  });

  it("capitalizes plain words", () => {
    expect(titleCase("budget gaming build")).toBe("Budget Gaming Build");
  });
});

describe("getErrorMessageText", () => {
  it("parses valid JSON with message key", () => {
    expect(getErrorMessageText('{"message": "JSON message"}')).toBe("JSON message");
  });

  it("parses valid JSON with error object and message", () => {
    expect(getErrorMessageText('{"error": {"message": "Error object message"}}')).toBe("Error object message");
  });

  it("parses valid JSON with error as string", () => {
    expect(getErrorMessageText('{"error": "String error"}')).toBe("String error");
  });

  it("falls back to raw string if not JSON", () => {
    expect(getErrorMessageText("Raw error message")).toBe("Raw error message");
  });

  it("extracts nested JSON from text", () => {
    expect(getErrorMessageText('Prefix {"message": "Extracted message"} Suffix')).toBe("Extracted message");
  });
});

describe("getErrorMessage", () => {
  it("returns default message for empty error message", () => {
    expect(getErrorMessage(new Error(""))).toContain("Something interrupted");
  });

  it("returns parsed error message", () => {
    expect(getErrorMessage(new Error('{"message": "Parsed message"}'))).toBe("Parsed message");
  });

  it("formats plain object with message property", () => {
    expect(getErrorMessage({ message: "Plain object error" })).toBe("Plain object error");
  });
});

describe("formatModelName", () => {
  it("formats long local GGUF cache filepaths to concise filename without extension", () => {
    const raw = "/home/manishm/.cache/huggingface/hub/models--deepreinforce-ai--Ornith-1.0-9B-GGUF/snapshots/3296bc7a404871a72ac3f1903f561459c09b5c17/ornith-1.0-9b-Q6_K.gguf";
    expect(formatModelName(raw)).toBe("ornith-1.0-9b-Q6_K");
  });

  it("formats standard filepaths", () => {
    expect(formatModelName("/models/llama-3.3-70b.gguf")).toBe("llama-3.3-70b");
    expect(formatModelName("C:\\models\\mistral-7b.bin")).toBe("mistral-7b");
  });

  it("formats provider-prefixed model names", () => {
    expect(formatModelName("gemini:gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(formatModelName("ollama:llama3.3")).toBe("llama3.3");
  });

  it("preserves model tags like :free or :instruct on OpenRouter models", () => {
    expect(formatModelName("z-ai/glm-5.2:free")).toBe("glm-5.2:free");
    expect(formatModelName("meta-llama/llama-3.3-70b-instruct")).toBe("llama-3.3-70b-instruct");
  });

  it("handles HuggingFace models-- namespace format", () => {
    expect(formatModelName("models--deepreinforce-ai--Ornith-1.0-9B")).toBe("deepreinforce-ai/Ornith-1.0-9B");
  });

  it("returns Sage for undefined or empty string", () => {
    expect(formatModelName(undefined)).toBe("Sage");
    expect(formatModelName("")).toBe("Sage");
  });
});

describe("formatStarterBudget", () => {
  it("formats INR starter budget", () => {
    expect(formatStarterBudget("INR", "en-IN")).toMatch(/90,000/);
    expect(formatStarterBudget("INR", "en-IN")).toMatch(/₹/);
  });

  it("formats USD starter budget", () => {
    expect(formatStarterBudget("USD", "en-US")).toBe("$1,200");
  });

  it("formats EUR starter budget", () => {
    expect(formatStarterBudget("EUR", "en-US")).toMatch(/€1,100/);
  });

  it("formats GBP starter budget", () => {
    expect(formatStarterBudget("GBP", "en-GB")).toMatch(/£1,000/);
  });

  it("formats JPY starter budget without decimals", () => {
    expect(formatStarterBudget("JPY", "ja-JP")).toMatch(/180,000/);
  });

  it("handles unknown/fallback currencies gracefully", () => {
    expect(formatStarterBudget("XYZ", "en-US")).toContain("1,200");
    expect(formatStarterBudget(undefined, "en-IN")).toMatch(/90,000/);
  });
});

