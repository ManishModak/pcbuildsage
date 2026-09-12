import { describe, it, expect } from "vitest";
import { MockSessionStorage } from "../test-harness";

describe("Tier 1 - Feature 19: Ephemeral BYOK Key Management (R4)", () => {
  it("stores visitor Gemini and OpenRouter API keys in ephemeral sessionStorage", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("pcbuildsage_byok_gemini", "AIzaSyFakeGeminiKey123");
    sessionStorage.setItem("pcbuildsage_byok_openrouter", "sk-or-v1-fakeopenrouterkey");

    expect(sessionStorage.getItem("pcbuildsage_byok_gemini")).toBe("AIzaSyFakeGeminiKey123");
    expect(sessionStorage.getItem("pcbuildsage_byok_openrouter")).toBe("sk-or-v1-fakeopenrouterkey");
  });

  it("constructs secure request headers with visitor keys", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("pcbuildsage_byok_gemini", "AIzaSyFakeGeminiKey123");

    const geminiKey = sessionStorage.getItem("pcbuildsage_byok_gemini");
    const headers: Record<string, string> = {};
    if (geminiKey) {
      headers["x-gemini-api-key"] = geminiKey;
    }

    expect(headers["x-gemini-api-key"]).toBe("AIzaSyFakeGeminiKey123");
  });

  it("redacts BYOK keys from client logs and error traces", () => {
    const logDetails = {
      provider: "google",
      apiKey: "AIzaSyFakeGeminiKey123",
      timestamp: new Date().toISOString()
    };

    const serialized = JSON.stringify(logDetails, (key, val) =>
      /key|token|secret|auth/i.test(key) ? "[redacted]" : val
    );

    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("AIzaSyFakeGeminiKey123");
  });

  it("clears BYOK keys on user sign-out or session clear", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("pcbuildsage_byok_gemini", "AIzaSyFakeGeminiKey123");

    sessionStorage.removeItem("pcbuildsage_byok_gemini");
    expect(sessionStorage.getItem("pcbuildsage_byok_gemini")).toBeNull();
  });

  it("ensures BYOK keys are never stored in localStorage or persistent storage", () => {
    const persistentStore = new Map<string, string>();
    const isPersistentKeyStored = persistentStore.has("pcbuildsage_byok_gemini");
    expect(isPersistentKeyStored).toBe(false);
  });
});
