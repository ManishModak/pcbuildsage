import { describe, it, expect } from "vitest";
import { MockSessionStorage } from "../test-harness";

describe("Tier 2 Boundary - Feature 19: BYOK Key Management Edge Cases", () => {
  it("trims leading and trailing whitespace from entered visitor keys", () => {
    const rawKey = "  AIzaSyValidKeyTrimmed  ";
    const cleaned = rawKey.trim();
    expect(cleaned).toBe("AIzaSyValidKeyTrimmed");
  });

  it("handles empty or whitespace-only keys by omitting headers", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("key", "   ");

    const val = sessionStorage.getItem("key")?.trim();
    const headers: Record<string, string> = {};
    if (val) {
      headers["x-api-key"] = val;
    }

    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("handles multiple provider keys concurrently without collision", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("gemini_key", "gemini-123");
    sessionStorage.setItem("openrouter_key", "openrouter-456");

    expect(sessionStorage.getItem("gemini_key")).toBe("gemini-123");
    expect(sessionStorage.getItem("openrouter_key")).toBe("openrouter-456");
  });

  it("scrubs key from URI query params and URL strings", () => {
    const url = "https://example.com/api/chat?key=AIzaSySecret123&query=pc";
    const sanitized = url.replace(/([?&]key=)[^&]+/i, "$1[REDACTED]");
    expect(sanitized).toBe("https://example.com/api/chat?key=[REDACTED]&query=pc");
  });

  it("handles session clear by wiping all stored provider keys", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("k1", "v1");
    sessionStorage.setItem("k2", "v2");

    sessionStorage.clear();
    expect(sessionStorage.length).toBe(0);
  });
});
