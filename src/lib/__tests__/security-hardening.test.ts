import { describe, it, expect, vi, beforeEach } from "vitest";
import nextConfig from "../../../next.config";
import { POST as searchProbeRoute } from "@/app/api/search/probe/route";
import { apiKeyHeaders, hasUiKey } from "../client-config-store";
import { setByokKey, resetByokStoreForTesting, setByokStorageForTesting } from "../llm/client-byok-store";
import type { ChainEntry } from "@/types/client";

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.get(key) ?? null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}

describe("Security Hardening & Defense-in-Depth", () => {
  let mockSessionStorage: MockStorage;
  let mockLocalStorage: MockStorage;

  beforeEach(() => {
    mockSessionStorage = new MockStorage();
    mockLocalStorage = new MockStorage();
    setByokStorageForTesting(mockSessionStorage, mockLocalStorage);
    return () => {
      resetByokStoreForTesting();
    };
  });

  describe("Next.js HTTP Security Headers & Content Security Policy", () => {
    it("exports an async headers() function configuring security headers on all routes", async () => {
      expect(typeof nextConfig.headers).toBe("function");
      const headersConfig = await nextConfig.headers!();
      expect(headersConfig.length).toBeGreaterThan(0);

      const rootRule = headersConfig.find((r) => r.source === "/:path*");
      expect(rootRule).toBeDefined();

      const headerMap = Object.fromEntries(
        rootRule!.headers.map((h) => [h.key.toLowerCase(), h.value])
      );

      // Verify anti-clickjacking
      expect(headerMap["x-frame-options"]).toBe("DENY");

      // Verify MIME type sniffing protection
      expect(headerMap["x-content-type-options"]).toBe("nosniff");

      // Verify referrer policy
      expect(headerMap["referrer-policy"]).toBe("strict-origin-when-cross-origin");

      // Verify permissions policy
      expect(headerMap["permissions-policy"]).toContain("camera=()");
      expect(headerMap["permissions-policy"]).toContain("microphone=()");

      // Verify CSP directives
      const csp = headerMap["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src");
      expect(csp).toContain("https://generativelanguage.googleapis.com");
      expect(csp).toContain("https://openrouter.ai");
    });
  });

  describe("Search Probe Headers-Only Transmission", () => {
    it("accepts API key via x-pcbuildsage-api-key-<provider> header without requiring key in body", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: "Test GPU" }] })
      } as Response);

      try {
        const req = new Request("http://localhost/api/search/probe", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pcbuildsage-api-key-tavily": "tvly-header-test-key"
          },
          body: JSON.stringify({
            provider: "tavily"
            // No apiKey in body!
          })
        });

        const res = await searchProbeRoute(req);
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.resultCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("prioritizes header API key over body API key", async () => {
      let passedKey: string | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url, init) => {
        const headers = init?.headers as Record<string, string>;
        passedKey = headers?.Authorization?.replace("Bearer ", "") ?? headers?.["x-api-key"];
        return Promise.resolve({
          ok: true,
          json: async () => ({ results: [] })
        } as Response);
      });

      try {
        const req = new Request("http://localhost/api/search/probe", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pcbuildsage-api-key-tavily": "header-priority-key"
          },
          body: JSON.stringify({
            provider: "tavily",
            apiKey: "body-key-to-ignore"
          })
        });

        const res = await searchProbeRoute(req);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(passedKey).toBe("header-priority-key");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Unified Ephemeral BYOK Integration in client-config-store", () => {
    it("resolves ephemeral BYOK keys from sessionStorage in apiKeyHeaders", () => {
      setByokKey("gemini", "AIzaSyEphemeralBYOKKey999", false);

      const chain: ChainEntry[] = [
        {
          id: "entry-1",
          provider: "gemini",
          model: "gemini-2.5-flash",
          keySource: "ui"
        }
      ];

      const headers = apiKeyHeaders(chain);
      expect(headers["x-pcbuildsage-api-key-gemini"]).toBe("AIzaSyEphemeralBYOKKey999");
    });

    it("hasUiKey returns true when key exists in ephemeral BYOK store", () => {
      expect(hasUiKey("openrouter")).toBe(false);
      setByokKey("openrouter", "sk-or-v1-ephemeral", false);
      expect(hasUiKey("openrouter")).toBe(true);
    });
  });
});
