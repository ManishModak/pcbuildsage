import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getDeploymentMode,
  isHostedDemo,
  isLocal,
  isRouteBlockedInHostedMode,
  normalizeRoutePath,
  validateChatProviderUrl,
  validateSearchBaseUrl
} from "@/lib/config/deployment";
import { assertSafeSearchConfig, UnsafeConfigError } from "@/app/api/_lib/credentials";
import { getMarketByCode } from "@/lib/config/markets";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";
import { GET as getStatus } from "@/app/api/status/route";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getMarkets } from "@/app/api/markets/route";
import { POST as postChat } from "@/app/api/chat/route";
import { POST as postProbe } from "@/app/api/llm/probe/route";
import { GET as getModels } from "@/app/api/models/route";
import { POST as postScrape } from "@/app/api/scrape/route";
import { GET as getProfiles } from "@/app/api/profiles/route";
import { POST as postProfilesImport } from "@/app/api/profiles/import/route";
import { POST as postProfilesTest } from "@/app/api/profiles/test/route";
import { GET as getLogs } from "@/app/api/logs/route";
import { assertSafeFetchUrl, UnsafeUrlError } from "@/app/api/_lib/url-guard";

describe("M0 Empirical Challenger: Adversarial Stress & Edge-Case Suite", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  describe("Category 1: SSRF & LLM Provider URL Validation Attacks", () => {
    const dangerousUrls = [
      // AWS / Cloud IMDS
      "http://169.254.169.254",
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254",
      "https://169.254.169.254/latest/meta-data/",
      "http://169.254.170.2", // AWS ECS task metadata
      // IPv6 Loopbacks and local ranges
      "http://[::1]",
      "https://[::1]",
      "http://[::1]:8080/v1",
      "http://[0000:0000:0000:0000:0000:0000:0000:0001]",
      "https://[0:0:0:0:0:0:0:1]",
      "http://[::ffff:127.0.0.1]",
      "https://[::ffff:127.0.0.1]",
      "http://[::ffff:169.254.169.254]",
      "http://[fe80::1]",
      "http://[fc00::1]",
      // IPv4 Loopback and Private IP ranges
      "http://127.0.0.1",
      "http://127.0.0.1:8080",
      "http://127.0.1.1",
      "http://127.127.127.127",
      "http://0.0.0.0",
      "http://0.0.0.0:8000",
      "http://10.0.0.1",
      "http://10.255.255.254",
      "http://172.16.0.1",
      "http://172.20.0.1",
      "http://172.31.255.255",
      "http://192.168.0.1",
      "http://192.168.1.254",
      // Hostname tricks & DNS spoofing
      "http://localhost",
      "http://localhost:11434",
      "https://localhost",
      "http://service.localhost",
      "http://app.local",
      "http://kubernetes.default.svc.cluster.local",
      "http://internal.company.internal",
      "https://evil-openrouter.ai",
      "https://openrouter.ai.attacker.com",
      "https://notopenrouter.ai",
      "https://attackergoogleapis.com",
      "https://googleapis.com.attacker.com",
      "https://openrouter.ai@attacker.com",
      "https://attacker.com#openrouter.ai",
      "https://attacker.com?url=https://openrouter.ai",
      // Integer / Decimal / Hex / Octal encoded IPs
      "http://2130706433", // 127.0.0.1 in decimal
      "https://2130706433",
      "http://2852039166", // 169.254.169.254 in decimal
      "http://3232235777", // 192.168.1.1 in decimal
      "http://167772161",  // 10.0.0.1 in decimal
      "http://0x7f000001",
      "http://0177.0.0.1",
      // Dangerous Schemes
      "gopher://127.0.0.1:6379/_",
      "dict://127.0.0.1:11211/",
      "file:///etc/passwd",
      "ftp://openrouter.ai",
      "data:text/plain;base64,SGVsbG8=",
      "javascript:alert(1)",
      // Embedded credentials
      "https://admin:secret@openrouter.ai",
      "https://user:pass@generativelanguage.googleapis.com",
      // Non-standard ports on valid domains
      "https://openrouter.ai:8080/api/v1",
      "https://openrouter.ai:80/api/v1",
      "https://api.openai.com:8443/v1"
    ];

    dangerousUrls.forEach((url) => {
      it(`blocks dangerous URL in hosted-demo mode: ${url}`, () => {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
        expect(result.reason).toBeDefined();
      });
    });

    it("allows valid allowlisted provider endpoints over HTTPS on port 443 in hosted-demo mode", () => {
      const validUrls = [
        "https://generativelanguage.googleapis.com",
        "https://openrouter.ai/api/v1",
        "https://api.openai.com/v1",
        "https://api.anthropic.com/v1",
        "https://api.groq.com/openai/v1",
        "https://api.deepseek.com/v1",
        "https://api.together.ai/v1",
        "https://api.mistral.ai/v1",
        "https://api.cohere.com/v1",
        "https://api.perplexity.ai",
        "https://OPENROUTER.AI/api/v1", // case-insensitive host
        "https://openrouter.ai:443/api/v1", // explicit 443
        "  https://openrouter.ai/api/v1  ", // whitespace padded
        "", // empty defaults to safe provider
        undefined // undefined defaults to safe provider
      ];

      for (const url of validUrls) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(true);
      }
    });

    it("permits arbitrary valid URLs in local mode for local dev flexibility", () => {
      expect(validateChatProviderUrl("http://localhost:11434", "local").allowed).toBe(true);
      expect(validateChatProviderUrl("http://127.0.0.1:8000/v1", "local").allowed).toBe(true);
      expect(validateChatProviderUrl("http://192.168.1.50:5000", "local").allowed).toBe(true);
    });

    it("assertSafeFetchUrl blocks SSRF in profile imports", () => {
      expect(() => assertSafeFetchUrl("http://169.254.169.254/latest/meta-data")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("http://127.0.0.1/profile.json")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("http://localhost:3000/profile.json")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("http://[::1]/profile.json")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("http://10.0.0.1/profile.json")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("http://192.168.1.1/profile.json")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("file:///etc/passwd")).toThrow(UnsafeUrlError);
      expect(() => assertSafeFetchUrl("https://user:pass@example.com/profile.json")).toThrow(UnsafeUrlError);
      
      const safe = assertSafeFetchUrl("https://example.com/profile.json");
      expect(safe.hostname).toBe("example.com");
    });

    it("validateSearchBaseUrl strictly blocks SSRF search targets and permits safe ones", () => {
      // Malicious targets
      expect(validateSearchBaseUrl("http://169.254.169.254", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("http://127.0.0.1:8080", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("http://localhost:8080", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("https://localhost:8080", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("https://10.0.0.1", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("https://192.168.1.1", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("https://evil.com/search", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("https://user:pass@html.duckduckgo.com", "hosted-demo").allowed).toBe(false);
      expect(validateSearchBaseUrl("https://html.duckduckgo.com:8443", "hosted-demo").allowed).toBe(false);

      // Safe / empty targets
      expect(validateSearchBaseUrl(undefined, "hosted-demo").allowed).toBe(true);
      expect(validateSearchBaseUrl("", "hosted-demo").allowed).toBe(true);
      expect(validateSearchBaseUrl("https://html.duckduckgo.com", "hosted-demo").allowed).toBe(true);
      expect(validateSearchBaseUrl("https://api.search.brave.com", "hosted-demo").allowed).toBe(true);
      expect(validateSearchBaseUrl("https://api.exa.ai", "hosted-demo").allowed).toBe(true);
      expect(validateSearchBaseUrl("https://api.tavily.com", "hosted-demo").allowed).toBe(true);

      // Local mode allows any valid URL
      expect(validateSearchBaseUrl("http://localhost:8080", "local").allowed).toBe(true);
      expect(validateSearchBaseUrl("http://127.0.0.1:8888", "local").allowed).toBe(true);
    });

    it("assertSafeSearchConfig disallows searxng and unapproved search URLs in hosted-demo mode", () => {
      expect(() => {
        assertSafeSearchConfig({ provider: "searxng", crawlEnabled: false }, "hosted-demo");
      }).toThrow(UnsafeConfigError);

      expect(() => {
        assertSafeSearchConfig({ provider: "duckduckgo", baseUrl: "http://169.254.169.254", crawlEnabled: false }, "hosted-demo");
      }).toThrow(UnsafeConfigError);

      expect(() => {
        assertSafeSearchConfig({ provider: "duckduckgo", crawlEnabled: false }, "hosted-demo");
      }).not.toThrow();

      // Local mode permits searxng
      expect(() => {
        assertSafeSearchConfig({ provider: "searxng", baseUrl: "http://localhost:8080", crawlEnabled: false }, "local");
      }).not.toThrow();
    });
  });

  describe("Category 2: Endpoint-Level SSRF Rejection (/api/chat, /api/llm/probe, /api/models)", () => {
    it("POST /api/chat rejects malicious baseUrl in config body", async () => {
      const request = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [
              { provider: "openai-compatible", model: "custom", baseUrl: "http://169.254.169.254" }
            ]
          }
        })
      });

      const response = await postChat(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("permitted");
    });

    it("POST /api/chat rejects ollama provider in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [
              { provider: "ollama", model: "llama3" }
            ]
          }
        })
      });

      const response = await postChat(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("ollama");
    });

    it("POST /api/chat rejects malicious baseUrl injected via x-pcbuildsage-config header", async () => {
      const maliciousHeader = JSON.stringify({
        llmChain: [
          { provider: "openai-compatible", model: "custom", baseUrl: "http://127.0.0.1:8080" }
        ]
      });

      const request = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pcbuildsage-config": maliciousHeader
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }]
        })
      });

      const response = await postChat(request);
      expect(response.status).toBe(400);
    });

    it("POST /api/chat rejects searchProvider searxng in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "none" }],
            searchProvider: "searxng",
            searchBaseUrl: "http://localhost:8080"
          }
        })
      });

      const response = await postChat(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("searxng");
    });

    it("POST /api/chat rejects malicious searchBaseUrl in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "none" }],
            searchProvider: "duckduckgo",
            searchBaseUrl: "http://169.254.169.254"
          }
        })
      });

      const response = await postChat(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("permitted");
    });

    it("POST /api/chat rejects malicious searchBaseUrl via x-pcbuildsage-config header", async () => {
      const maliciousHeader = JSON.stringify({
        llmChain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "none" }],
        searchProvider: "searxng",
        searchBaseUrl: "http://127.0.0.1:8080"
      });

      const request = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pcbuildsage-config": maliciousHeader
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }]
        })
      });

      const response = await postChat(request);
      expect(response.status).toBe(400);
    });

    it("POST /api/llm/probe rejects SSRF baseUrl in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/llm/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          model: "gpt-4",
          baseUrl: "http://169.254.169.254/latest/meta-data"
        })
      });

      const response = await postProbe(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("permitted");
    });

    it("POST /api/llm/probe rejects ollama in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/llm/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "ollama",
          model: "llama3"
        })
      });

      const response = await postProbe(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("ollama");
    });

    it("GET /api/models rejects SSRF baseUrl in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/models?provider=openai-compatible&baseUrl=http://127.0.0.1:8080", {
        method: "GET"
      });

      const response = await getModels(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("permitted");
    });

    it("GET /api/models rejects ollama in hosted-demo mode", async () => {
      const request = new Request("http://localhost:3000/api/models?provider=ollama", {
        method: "GET"
      });

      const response = await getModels(request);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(JSON.stringify(json)).toContain("ollama");
    });
  });

  describe("Category 3: Route Guard Adversarial Bypasses & Path Tampering", () => {
    const blockedRoutes = [
      "/api/scrape",
      "/api/profiles",
      "/api/profiles/import",
      "/api/profiles/test",
      "/api/logs"
    ];

    const mutationMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

    it("blocks all target routes across all HTTP methods in isRouteBlockedInHostedMode", () => {
      for (const route of blockedRoutes) {
        for (const method of mutationMethods) {
          expect(isRouteBlockedInHostedMode(route, method, "hosted-demo")).toBe(true);
        }
      }
    });

    it("blocks URL-encoded path variants", () => {
      const variants = [
        "%2fapi%2fscrape",
        "/api/%73crape",
        "/api/%70rofiles",
        "/api/%70rofiles/import",
        "/api/profiles/%69mport",
        "/api/%70rofiles/%74est",
        "/api/%6cog%73",
        "/%61%70%69/%73%63%72%61%70%65"
      ];

      for (const variant of variants) {
        expect(isRouteBlockedInHostedMode(variant, "POST", "hosted-demo")).toBe(true);
      }
    });

    it("blocks trailing slashes", () => {
      const slashed = [
        "/api/scrape/",
        "/api/scrape///",
        "/api/profiles/",
        "/api/profiles/import/",
        "/api/logs/"
      ];

      for (const s of slashed) {
        expect(isRouteBlockedInHostedMode(s, "POST", "hosted-demo")).toBe(true);
      }
    });

    it("blocks leading double-slashes, internal multi-slashes, and dot-segments via path normalization", () => {
      expect(isRouteBlockedInHostedMode("//api/scrape", "POST", "hosted-demo")).toBe(true);
      expect(isRouteBlockedInHostedMode("//api//scrape", "POST", "hosted-demo")).toBe(true);
      expect(isRouteBlockedInHostedMode("///api///scrape", "POST", "hosted-demo")).toBe(true);
      expect(isRouteBlockedInHostedMode("/api/./scrape", "POST", "hosted-demo")).toBe(true);
      expect(isRouteBlockedInHostedMode("/api/../api/scrape", "POST", "hosted-demo")).toBe(true);
      expect(isRouteBlockedInHostedMode("/foo/../api/scrape", "POST", "hosted-demo")).toBe(true);
      expect(isRouteBlockedInHostedMode("///api///profiles///", "GET", "hosted-demo")).toBe(true);

      // Verify edge middleware blocks these normalized variants
      const req1 = new NextRequest("http://localhost:3000//api/scrape", { method: "POST" });
      expect(middleware(req1).status).toBe(403);

      const req2 = new NextRequest("http://localhost:3000/api/./scrape", { method: "POST" });
      expect(middleware(req2).status).toBe(403);

      const req3 = new NextRequest("http://localhost:3000/foo/../api/logs", { method: "GET" });
      expect(middleware(req3).status).toBe(403);
    });

    it("normalizeRoutePath resolves dots, multiple slashes, and decodes safely", () => {
      expect(normalizeRoutePath("//api//scrape")).toBe("/api/scrape");
      expect(normalizeRoutePath("/api/./scrape")).toBe("/api/scrape");
      expect(normalizeRoutePath("/api/../api/scrape")).toBe("/api/scrape");
      expect(normalizeRoutePath("///api///profiles///")).toBe("/api/profiles");
      expect(normalizeRoutePath("%2fapi%2fscrape")).toBe("/api/scrape");
      expect(normalizeRoutePath("/api/%73crape")).toBe("/api/scrape");
      expect(normalizeRoutePath("/api/scrape?foo=bar#section")).toBe("/api/scrape");
      expect(normalizeRoutePath("")).toBe("/");
    });

    it("blocks case-manipulated path variants", () => {
      const casingVariants = [
        "/API/SCRAPE",
        "/Api/Scrape",
        "/api/Scrape",
        "/API/PROFILES",
        "/api/Profiles/Import",
        "/API/LOGS"
      ];

      for (const c of casingVariants) {
        expect(isRouteBlockedInHostedMode(c, "POST", "hosted-demo")).toBe(true);
        const req = new NextRequest(`http://localhost:3000${c}`, { method: "POST" });
        const res = middleware(req);
        expect(res.status).toBe(403);
      }
    });

    it("blocks subpaths of guarded routes", () => {
      const subpaths = [
        "/api/scrape/start",
        "/api/scrape/worker/1",
        "/api/profiles/custom-id",
        "/api/profiles/import/bulk",
        "/api/logs/stream"
      ];

      for (const sub of subpaths) {
        expect(isRouteBlockedInHostedMode(sub, "POST", "hosted-demo")).toBe(true);
      }
    });

    it("route handlers have defense-in-depth: return 403 unconditionally in hosted-demo mode", async () => {
      const dummyReq = new Request("http://localhost:3000/api/scrape", { method: "POST" });

      const scrapeRes = await postScrape(dummyReq);
      expect(scrapeRes.status).toBe(403);
      const scrapeJson = await scrapeRes.json();
      expect(scrapeJson.code).toBe("HOSTED_DEMO_FORBIDDEN");

      const profilesRes = await getProfiles(dummyReq);
      expect(profilesRes.status).toBe(403);

      const importRes = await postProfilesImport(dummyReq);
      expect(importRes.status).toBe(403);

      const testRes = await postProfilesTest(dummyReq);
      expect(testRes.status).toBe(403);

      const logsRes = await getLogs(dummyReq);
      expect(logsRes.status).toBe(403);
    });

    it("allows public routes in hosted-demo mode without interference", () => {
      const publicRoutes = [
        "/api/markets",
        "/api/status",
        "/api/health",
        "/api/chat",
        "/api/llm/probe",
        "/api/models"
      ];

      for (const pub of publicRoutes) {
        expect(isRouteBlockedInHostedMode(pub, "GET", "hosted-demo")).toBe(false);
        const req = new NextRequest(`http://localhost:3000${pub}`, { method: "GET" });
        const res = middleware(req);
        expect(res.status).not.toBe(403);
      }
    });

    it("allows all routes in local mode", () => {
      for (const route of blockedRoutes) {
        expect(isRouteBlockedInHostedMode(route, "POST", "local")).toBe(false);
      }
    });
  });

  describe("Category 4: Market Metadata Endpoint & Data Leakage Prevention", () => {
    it("returns clean market metadata conforming strictly to MarketMetadata contract", async () => {
      const response = await getMarkets();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("markets");
      expect(Array.isArray(body.markets)).toBe(true);
      expect(body.markets.length).toBeGreaterThanOrEqual(5);

      const stringified = JSON.stringify(body);

      // Verify absence of scraper selectors, cheerio configs, crawler internals
      const forbiddenTokens = [
        "selector",
        "cheerio",
        "crawler",
        "category_url",
        "search_url",
        "product_link",
        "price_selector",
        "title_selector",
        "availability_selector",
        "user_agent",
        "headers",
        "cookies",
        "api_key",
        "token",
        "secret",
        "password",
        "turso",
        "sqlite",
        "dbPath"
      ];

      for (const token of forbiddenTokens) {
        expect(stringified.toLowerCase()).not.toContain(token.toLowerCase());
      }

      // Verify exact keys on every market entry
      for (const m of body.markets) {
        const keys = Object.keys(m);
        expect(keys.sort()).toEqual(["code", "defaultCurrency", "locale", "name", "supportedCurrencies"].sort());
        expect(typeof m.code).toBe("string");
        expect(m.code).toMatch(/^[A-Z]{2}$/);
        expect(typeof m.name).toBe("string");
        expect(typeof m.defaultCurrency).toBe("string");
        expect(m.defaultCurrency).toMatch(/^[A-Z]{3}$/);
        expect(Array.isArray(m.supportedCurrencies)).toBe(true);
        expect(typeof m.locale).toBe("string");
      }
    });

    it("getMarketByCode returns valid metadata or undefined", () => {
      expect(getMarketByCode("US")?.name).toBe("United States");
      expect(getMarketByCode("UK")?.defaultCurrency).toBe("GBP");
      expect(getMarketByCode("IN")?.defaultCurrency).toBe("INR");
      expect(getMarketByCode("XX")).toBeUndefined();
      expect(getMarketByCode("")).toBeUndefined();
    });
  });

  describe("Category 5: Status & Health Sanitization in Hosted-Demo vs Local", () => {
    it("GET /api/status in hosted-demo mode sanitizes server filesystem paths, python interpreter, and secrets", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const response = await getStatus();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.mode).toBe("hosted-demo");
      expect(body.deploymentMode).toBe("hosted-demo");
      expect(body).toHaveProperty("catalogFreshness");
      expect(body).toHaveProperty("productCount");
      expect(typeof body.productCount).toBe("number");

      // Verify NO python process information is exposed
      expect(body.python).toBeUndefined();

      // Verify database object contains NO absolute filesystem path
      expect(body.database).toBeDefined();
      expect(body.database.path).toBeUndefined();

      const stringified = JSON.stringify(body);
      expect(stringified).not.toContain("/home/");
      expect(stringified).not.toContain("/usr/bin");
      expect(stringified).not.toContain("python");
      expect(stringified).not.toContain("TURSO");
      expect(stringified).not.toContain("products.db");
    });

    it("GET /api/status in local mode includes database.path and python info for local diagnostics", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
      const response = await getStatus();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.mode).toBe("local");
      expect(body.deploymentMode).toBe("local");
      expect(body.database).toBeDefined();
      expect(body.database.path).toBeDefined();
      expect(body.python).toBeDefined();
    });

    it("GET /api/health responds with lightweight status without local DB queries", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const response = await getHealth();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.mode).toBe("hosted-demo");
      expect(body.timestamp).toBeDefined();
      expect(body.database).toBeUndefined();
      expect(body.python).toBeUndefined();
    });
  });

  describe("Category 6: Deployment Mode Resolver Rigor", () => {
    it("safely handles explicit parameter strings and environment objects", () => {
      expect(getDeploymentMode("hosted-demo")).toBe("hosted-demo");
      expect(getDeploymentMode("HOSTED-DEMO")).toBe("hosted-demo");
      expect(getDeploymentMode("  hosted-demo  \n")).toBe("hosted-demo");
      expect(getDeploymentMode("Hosted-Demo")).toBe("hosted-demo");
      
      expect(getDeploymentMode("local")).toBe("local");
      expect(getDeploymentMode("LOCAL")).toBe("local");
      expect(getDeploymentMode("  local ")).toBe("local");
      expect(getDeploymentMode("production")).toBe("local");
      expect(getDeploymentMode("staging")).toBe("local");
      expect(getDeploymentMode("")).toBe("local");
      
      expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe("hosted-demo");
      expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe("local");
      expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: undefined })).toBe("local");
      expect(getDeploymentMode({})).toBe("local");
    });

    it("isHostedDemo and isLocal predicates work with explicit inputs", () => {
      expect(isHostedDemo("hosted-demo")).toBe(true);
      expect(isHostedDemo("local")).toBe(false);
      expect(isHostedDemo({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe(true);
      expect(isHostedDemo({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe(false);

      expect(isLocal("local")).toBe(true);
      expect(isLocal("hosted-demo")).toBe(false);
      expect(isLocal({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe(true);
      expect(isLocal({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe(false);
    });
  });
});
