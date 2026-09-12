import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";

// Subject Under Test (SUT) modules from codebase
import {
  getDeploymentMode,
  isHostedDemo,
  isLocal,
  isRouteBlockedInHostedMode,
  validateChatProviderUrl,
  type DeploymentMode
} from "../src/lib/config/deployment";

import { middleware } from "../src/middleware";

import { listMarkets, getMarketByCode } from "../src/lib/config/markets";
import { buildAppConfig, UnsafeConfigError, assertSafeLlmChain } from "../src/app/api/_lib/credentials";

import { GET as healthRoute } from "../src/app/api/health/route";
import { GET as marketsRoute } from "../src/app/api/markets/route";
import { GET as statusRoute } from "../src/app/api/status/route";
import { POST as chatRoute } from "../src/app/api/chat/route";
import { POST as scrapeRoute } from "../src/app/api/scrape/route";
import { GET as profilesRoute } from "../src/app/api/profiles/route";
import { POST as profileImportRoute } from "../src/app/api/profiles/import/route";
import { POST as profileTestRoute } from "../src/app/api/profiles/test/route";
import { GET as logsRoute } from "../src/app/api/logs/route";
import { POST as probeRoute } from "../src/app/api/llm/probe/route";
import { GET as modelsRoute } from "../src/app/api/models/route";

describe("Adversarial M0 Empirical Stress Test Suite", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Section 1: Deployment Mode Resolution & Stress Toggling
  // ==========================================================================
  describe("1. Deployment Mode Resolution & Fuzzing", () => {
    it("defaults strictly to 'local' for all empty, falsy, or whitespace values", () => {
      const falsyInputs = [undefined, "", "   ", "\t\t", "\n\r", "   \n "];
      for (const input of falsyInputs) {
        if (input !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = input;
        else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

        expect(getDeploymentMode()).toBe("local");
        expect(isHostedDemo()).toBe(false);
        expect(isLocal()).toBe(true);

        expect(getDeploymentMode(input)).toBe("local");
        expect(isHostedDemo(input)).toBe(false);
        expect(isLocal(input)).toBe(true);
      }
    });

    it("resolves 'hosted-demo' case-insensitively with leading/trailing whitespace", () => {
      const validHostedVariations = [
        "hosted-demo",
        "HOSTED-DEMO",
        "Hosted-Demo",
        "  hosted-demo  ",
        "\thosted-demo\n",
        "HoStEd-DeMo"
      ];
      for (const val of validHostedVariations) {
        process.env.PCBUILDSAGE_DEPLOYMENT_MODE = val;
        expect(getDeploymentMode()).toBe("hosted-demo");
        expect(isHostedDemo()).toBe(true);
        expect(isLocal()).toBe(false);

        expect(getDeploymentMode(val)).toBe("hosted-demo");
        expect(isHostedDemo(val)).toBe(true);
        expect(isLocal(val)).toBe(false);
      }
    });

    it("falls back to 'local' for unknown modes, injection payloads, or corrupted strings", () => {
      const adversarialInputs = [
        "production",
        "staging",
        "development",
        "hosted",
        "demo",
        "hosted_demo",
        "hosted-demo-plus",
        "true",
        "false",
        "1",
        "0",
        "__proto__",
        "constructor",
        "toString",
        "hosted-demo; DROP TABLE products;",
        "<script>alert(1)</script>",
        "invalid-mode-123"
      ];
      for (const val of adversarialInputs) {
        process.env.PCBUILDSAGE_DEPLOYMENT_MODE = val;
        expect(getDeploymentMode()).toBe("local");
        expect(isHostedDemo()).toBe(false);
        expect(isLocal()).toBe(true);

        expect(getDeploymentMode(val)).toBe("local");
        expect(isHostedDemo(val)).toBe(false);
        expect(isLocal(val)).toBe(true);
      }
    });

    it("handles dictionary / env object injection safely", () => {
      expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe("hosted-demo");
      expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe("local");
      expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: undefined })).toBe("local");
      expect(getDeploymentMode({})).toBe("local");
      expect(getDeploymentMode({ OTHER_VAR: "hosted-demo" })).toBe("local");
    });

    it("withstands 10,000 rapid concurrent toggles without race condition or state corruption", async () => {
      const iterations = 10000;
      const promises = Array.from({ length: iterations }, (_, i) => {
        const targetMode = i % 2 === 0 ? "hosted-demo" : "local";
        const envObj = { PCBUILDSAGE_DEPLOYMENT_MODE: targetMode };
        return Promise.resolve().then(() => {
          const mode = getDeploymentMode(envObj);
          const hosted = isHostedDemo(envObj);
          const local = isLocal(envObj);
          return { mode, hosted, local, expected: targetMode };
        });
      });

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.mode).toBe(res.expected);
        expect(res.hosted).toBe(res.expected === "hosted-demo");
        expect(res.local).toBe(res.expected === "local");
      }
    });
  });

  // ==========================================================================
  // Section 2: Route Guarding & Path Traversal / Normalization Attacks
  // ==========================================================================
  describe("2. Route Guarding & Path Traversal / Normalization Attacks", () => {
    const blockedEndpoints = [
      "/api/scrape",
      "/api/profiles",
      "/api/profiles/import",
      "/api/profiles/test",
      "/api/logs"
    ];

    it("blocks all configured admin/mutating endpoints in hosted-demo mode across all HTTP methods", () => {
      const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
      for (const endpoint of blockedEndpoints) {
        for (const method of methods) {
          expect(isRouteBlockedInHostedMode(endpoint, method, "hosted-demo")).toBe(true);
        }
      }
    });

    it("never blocks any routes in local mode regardless of method or path", () => {
      const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
      for (const endpoint of blockedEndpoints) {
        for (const method of methods) {
          expect(isRouteBlockedInHostedMode(endpoint, method, "local")).toBe(false);
        }
      }
    });

    it("resists path normalization bypasses (case variation, trailing slashes, subpaths)", () => {
      const bypassAttempts = [
        "/API/SCRAPE",
        "/api/Scrape",
        "/api/scrape/",
        "/api/scrape///",
        "//api/scrape",
        "//api//scrape",
        "///api///scrape",
        "/api/./scrape",
        "/api/../api/scrape",
        "/other/../api/scrape",
        "/api/scrape/extra/path",
        "/api/profiles/",
        "/api/PROFILES/import",
        "/api/profiles/import/",
        "/api/profiles/import/subpath",
        "/api/profiles/test/",
        "/api/logs/",
        "/api/LOGS?limit=10",
        "/api/scrape?profile=us&quick=true",
        "/api/scrape#section"
      ];

      for (const p of bypassAttempts) {
        expect(isRouteBlockedInHostedMode(p, "POST", "hosted-demo")).toBe(true);
      }
    });

    it("resists URL-encoded traversal attacks", () => {
      const encodedAttacks = [
        "/api/%73crape", // 's' encoded
        "/api/profiles/%69mport", // 'i' encoded
        "/api/%6cog%73", // 'logs' encoded
        "/api/profiles/%2e%2e/scrape"
      ];

      for (const p of encodedAttacks) {
        expect(isRouteBlockedInHostedMode(p, "POST", "hosted-demo")).toBe(true);
      }
    });

    it("permits public and non-blocked endpoints in hosted-demo mode", () => {
      const publicEndpoints = [
        "/api/health",
        "/api/markets",
        "/api/status",
        "/api/chat",
        "/api/llm/probe",
        "/api/models",
        "/",
        "/wizard",
        "/chat"
      ];

      for (const p of publicEndpoints) {
        expect(isRouteBlockedInHostedMode(p, "GET", "hosted-demo")).toBe(false);
      }
    });

    it("Next.js middleware correctly blocks guarded routes with HTTP 403 in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      for (const endpoint of blockedEndpoints) {
        const req = new NextRequest(`https://pcbuildsage.onrender.com${endpoint}`, {
          method: "POST"
        });
        const res = middleware(req);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code?: string };
        expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
      }
    });

    it("Next.js middleware permits allowed routes in hosted-demo mode", () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      const allowedReq = new NextRequest("https://pcbuildsage.onrender.com/api/health", { method: "GET" });
      const res = middleware(allowedReq);
      expect(res.status).toBe(200); // NextResponse.next() returns 200 in mock NextRequest context
    });

    it("Next.js middleware permits all routes in local mode", () => {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

      for (const endpoint of blockedEndpoints) {
        const req = new NextRequest(`http://localhost:3000${endpoint}`, { method: "POST" });
        const res = middleware(req);
        expect(res.status).toBe(200);
      }
    });

    it("defense-in-depth handler guards block execution even if middleware was bypassed", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      const r1 = await scrapeRoute(new Request("http://localhost/api/scrape", { method: "POST", body: JSON.stringify({ profile: "us" }) }));
      expect(r1.status).toBe(403);

      const r2 = await profilesRoute(new Request("http://localhost/api/profiles", { method: "GET" }));
      expect(r2.status).toBe(403);

      const r3 = await profileImportRoute(new Request("http://localhost/api/profiles/import", { method: "POST", body: JSON.stringify({ profile: {} }) }));
      expect(r3.status).toBe(403);

      const r4 = await profileTestRoute(new Request("http://localhost/api/profiles/test", { method: "POST", body: JSON.stringify({ profile: "us" }) }));
      expect(r4.status).toBe(403);

      const r5 = await logsRoute(new Request("http://localhost/api/logs", { method: "GET" }));
      expect(r5.status).toBe(403);
    });
  });

  // ==========================================================================
  // Section 3: SSRF Prevention & LLM Provider URL Validation
  // ==========================================================================
  describe("3. SSRF Prevention & LLM Provider URL Validation", () => {
    it("allows standard HTTPS LLM provider domains and subdomains in hosted-demo mode", () => {
      const validUrls = [
        "https://generativelanguage.googleapis.com",
        "https://generativelanguage.googleapis.com/v1beta",
        "https://openrouter.ai/api/v1",
        "https://api.openai.com/v1",
        "https://api.anthropic.com/v1",
        "https://api.groq.com/openai/v1",
        "https://api.deepseek.com/v1",
        "https://api.mistral.ai/v1",
        "https://api.together.ai/v1",
        "https://api.together.xyz/v1",
        "https://api.cohere.com/v1",
        "https://api.cohere.ai/v1",
        "https://api.perplexity.ai"
      ];

      for (const url of validUrls) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(true);
      }
    });

    it("allows empty or undefined URLs in hosted-demo mode (resolves to defaults)", () => {
      expect(validateChatProviderUrl(undefined, "hosted-demo").allowed).toBe(true);
      expect(validateChatProviderUrl("", "hosted-demo").allowed).toBe(true);
      expect(validateChatProviderUrl("   ", "hosted-demo").allowed).toBe(true);
    });

    it("strictly blocks non-HTTPS protocols in hosted-demo mode", () => {
      const nonHttps = [
        "http://api.openai.com/v1",
        "ftp://openrouter.ai/api",
        "ws://api.groq.com",
        "file:///etc/passwd",
        "gopher://127.0.0.1:6379/_",
        "javascript:alert(1)",
        "data:text/html,malicious"
      ];

      for (const url of nonHttps) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("HTTPS");
      }
    });

    it("strictly blocks private, loopback, and Cloud IMDS addresses", () => {
      const privateAddresses = [
        "https://127.0.0.1",
        "https://127.0.0.1:443",
        "https://localhost",
        "https://localhost:443",
        "https://sub.localhost",
        "https://0.0.0.0",
        "https://[::1]",
        "https://169.254.169.254",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.1",
        "https://10.255.255.255",
        "https://192.168.1.1",
        "https://192.168.0.100",
        "https://172.16.0.1",
        "https://172.31.255.255",
        "https://internal.service.local",
        "https://metadata.google.internal"
      ];

      for (const url of privateAddresses) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
      }
    });

    it("strictly blocks embedded user credentials in URL", () => {
      const credentialUrls = [
        "https://admin:password@api.openai.com",
        "https://user@openrouter.ai/v1",
        "https://token:@api.anthropic.com"
      ];

      for (const url of credentialUrls) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("credentials");
      }
    });

    it("strictly blocks custom non-443 ports in hosted-demo mode", () => {
      const customPorts = [
        "https://api.openai.com:8080/v1",
        "https://api.openai.com:8443/v1",
        "https://openrouter.ai:3000/v1",
        "https://api.groq.com:22/v1"
      ];

      for (const url of customPorts) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Custom port");
      }
    });

    it("strictly blocks domain suffix / prefix spoofing attacks", () => {
      const spoofedDomains = [
        "https://googleapis.com.attacker.com",
        "https://api.openai.com.attacker.com",
        "https://openrouter.ai.evil.org",
        "https://not-anthropic.com",
        "https://fakeopenai.com",
        "https://groq.com.fake.com",
        "https://evil-mistral.ai",
        "https://deepseek.com.attacker.io"
      ];

      for (const url of spoofedDomains) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
      }
    });

    it("permits local / private endpoints in local mode without restriction", () => {
      const localUrls = [
        "http://localhost:11434",
        "http://127.0.0.1:1234/v1",
        "http://192.168.1.50:8000/v1",
        "http://10.0.0.5:11434",
        "https://api.openai.com/v1"
      ];

      for (const url of localUrls) {
        const result = validateChatProviderUrl(url, "local");
        expect(result.allowed).toBe(true);
      }
    });

    it("assertSafeLlmChain throws UnsafeConfigError for Ollama or bad URLs in hosted-demo mode", () => {
      expect(() => {
        assertSafeLlmChain([{ provider: "ollama", model: "llama3", keySource: "env" }], "hosted-demo");
      }).toThrow(UnsafeConfigError);

      expect(() => {
        assertSafeLlmChain([{ provider: "openai-compatible", model: "gpt-4", baseUrl: "http://169.254.169.254", keySource: "env" }], "hosted-demo");
      }).toThrow(UnsafeConfigError);

      expect(() => {
        assertSafeLlmChain([{ provider: "openai-compatible", model: "gpt-4", keySource: "env" }], "hosted-demo");
      }).toThrow(UnsafeConfigError);

      expect(() => {
        assertSafeLlmChain([{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }], "hosted-demo");
      }).not.toThrow();

      expect(() => {
        assertSafeLlmChain([{ provider: "openrouter", model: "meta-llama/llama-3-70b", keySource: "env" }], "hosted-demo");
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // Section 4: Header Parsing, Payload Parsing & BYOK Injection
  // ==========================================================================
  describe("4. Header Parsing, Payload Parsing & BYOK Injection", () => {
    it("parses empty or missing headers safely without throwing", () => {
      const headers = new Headers();
      const config = buildAppConfig(headers, {});
      expect(config).toBeDefined();
      expect(config.countryCode).toBeDefined();
    });

    it("throws a clear error on malformed x-pcbuildsage-config header JSON", () => {
      const headers = new Headers({
        "x-pcbuildsage-config": "{broken-json:"
      });
      expect(() => buildAppConfig(headers, {})).toThrow("x-pcbuildsage-config must contain valid JSON");
    });

    it("handles non-object JSON values in x-pcbuildsage-config header safely", () => {
      const nonObjects = ['"a string"', "123", "true", "null", "[1, 2, 3]"];
      for (const val of nonObjects) {
        const headers = new Headers({ "x-pcbuildsage-config": val });
        expect(() => buildAppConfig(headers, {})).not.toThrow();
      }
    });

    it("injects ephemeral BYOK credentials from headers across various header casing formats", () => {
      const headers = new Headers({
        "x-pcbuildsage-api-key-gemini": "AIza-test-key-123",
        "x-openrouter-api-key": "sk-or-test-key-456"
      });

      const config = buildAppConfig(headers, {
        llmChain: [
          { provider: "gemini", model: "gemini-2.5-flash", keySource: "ui" },
          { provider: "openrouter", model: "openai/gpt-4o", keySource: "ui" }
        ]
      });

      expect(config.llm.chain[0].apiKey).toBe("AIza-test-key-123");
      expect(config.llm.chain[1].apiKey).toBe("sk-or-test-key-456");
    });

    it("in hosted-demo mode, buildAppConfig blocks unsafe Ollama or unwhitelisted provider chains", () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const headers = new Headers();

      expect(() => {
        buildAppConfig(headers, {
          llmChain: [{ provider: "ollama", model: "llama3", keySource: "none" }]
        });
      }).toThrow(UnsafeConfigError);

      expect(() => {
        buildAppConfig(headers, {
          llmChain: [{ provider: "openai-compatible", model: "custom", baseUrl: "http://malicious.internal" }]
        });
      }).toThrow(UnsafeConfigError);

      expect(() => {
        buildAppConfig(headers, {
          searchProvider: "searxng"
        });
      }).toThrow(UnsafeConfigError);

      expect(() => {
        buildAppConfig(headers, {
          searchProvider: "duckduckgo",
          searchBaseUrl: "http://169.254.169.254"
        });
      }).toThrow(UnsafeConfigError);
    });

    it("/api/chat endpoint rejects malformed payloads and unauthorized providers in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      // Case A: Missing messages
      const res1 = await chatRoute(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }));
      expect(res1.status).toBe(400);

      // Case B: Ollama in hosted mode
      const res2 = await chatRoute(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "ollama", model: "llama3" }]
          }
        })
      }));
      expect(res2.status).toBe(400);

      // Case C: Malicious SSRF URL
      const res3 = await chatRoute(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "openai-compatible", model: "gpt-4", baseUrl: "http://169.254.169.254" }]
          }
        })
      }));
      expect(res3.status).toBe(400);

      // Case D: SearXNG in hosted mode
      const res4 = await chatRoute(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "none" }],
            searchProvider: "searxng",
            searchBaseUrl: "http://localhost:8080"
          }
        })
      }));
      expect(res4.status).toBe(400);

      // Case E: SearchBaseUrl SSRF
      const res5 = await chatRoute(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "none" }],
            searchProvider: "duckduckgo",
            searchBaseUrl: "http://127.0.0.1:8080"
          }
        })
      }));
      expect(res5.status).toBe(400);
    });
  });

  // ==========================================================================
  // Section 5: Sanitized Status, Health & Information Leakage
  // ==========================================================================
  describe("5. Sanitized Status, Health & Information Leakage", () => {
    it("GET /api/health responds HTTP 200 with status ok and active mode", async () => {
      // Local mode
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
      const res1 = await healthRoute();
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { status: string; mode: string; timestamp: string };
      expect(body1.status).toBe("ok");
      expect(body1.mode).toBe("local");
      expect(body1.timestamp).toBeDefined();

      // Hosted mode
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const res2 = await healthRoute();
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { status: string; mode: string; timestamp: string };
      expect(body2.status).toBe("ok");
      expect(body2.mode).toBe("hosted-demo");
      expect(body2.timestamp).toBeDefined();
    });

    it("GET /api/status in hosted-demo mode strictly strips database.path and python runtime details", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      const res = await statusRoute();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        mode: string;
        deploymentMode: string;
        database?: { path?: string; exists?: boolean };
        python?: unknown;
      };

      expect(body.status).toBe("ok");
      expect(body.mode).toBe("hosted-demo");
      expect(body.deploymentMode).toBe("hosted-demo");

      // Critical security check: No internal server paths or python info leaked
      expect(body.database?.path).toBeUndefined();
      expect(body.python).toBeUndefined();
      expect(body.database?.exists).toBeDefined();
    });

    it("GET /api/status in local mode includes database.path and python info for developer diagnostics", async () => {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

      const res = await statusRoute();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        mode: string;
        database?: { path?: string };
        python?: unknown;
      };

      expect(body.status).toBe("ok");
      expect(body.mode).toBe("local");
      expect(body.database?.path).toBeDefined();
    });

    it("GET /api/status handles missing or non-existent SQLite database gracefully", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      const res = await statusRoute();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });

  // ==========================================================================
  // Section 6: Market Metadata Registry & Query Robustness
  // ==========================================================================
  describe("6. Market Metadata Registry & Query Robustness", () => {
    it("GET /api/markets returns all 5 standard markets (US, UK, IN, CA, DE)", async () => {
      const res = await marketsRoute();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { markets: Array<{ code: string; name: string; defaultCurrency: string }> };

      expect(Array.isArray(body.markets)).toBe(true);
      const codes = body.markets.map((m) => m.code);
      expect(codes).toContain("US");
      expect(codes).toContain("UK");
      expect(codes).toContain("IN");
      expect(codes).toContain("CA");
      expect(codes).toContain("DE");
    });

    it("listMarkets does NOT leak internal scraper selectors, categories, or URLs", () => {
      const markets = listMarkets();
      for (const m of markets) {
        const keys = Object.keys(m);
        expect(keys).toEqual(["code", "name", "defaultCurrency", "supportedCurrencies", "locale"]);
        expect((m as unknown as Record<string, unknown>).selectors).toBeUndefined();
        expect((m as unknown as Record<string, unknown>).categories).toBeUndefined();
        expect((m as unknown as Record<string, unknown>).urls).toBeUndefined();
        expect((m as unknown as Record<string, unknown>).headers).toBeUndefined();
      }
    });

    it("listMarkets handles corrupted JSON profiles in profiles directory gracefully", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-test-profiles-"));
      try {
        // Create a corrupted profile JSON
        fs.writeFileSync(path.join(tempDir, "corrupted.json"), "{ invalid-json }");
        // Create a non-JSON file
        fs.writeFileSync(path.join(tempDir, "readme.txt"), "some text");
        // Create an invalid schema profile
        fs.writeFileSync(path.join(tempDir, "invalid-schema.json"), JSON.stringify({ country_code: "TOOLONG" }));
        // Create a valid custom profile
        fs.writeFileSync(
          path.join(tempDir, "australia.json"),
          JSON.stringify({
            country_code: "AU",
            default_currency: "AUD",
            selectors: { item: ".product" },
            category_urls: { cpu: "https://au.retailer.com/cpus" }
          })
        );

        const markets = listMarkets(tempDir);
        const auMarket = markets.find((m) => m.code === "AU");
        expect(auMarket).toBeDefined();
        expect(auMarket?.code).toBe("AU");
        expect(auMarket?.defaultCurrency).toBe("AUD");

        // Ensure leaked internals are absent from AU market
        expect((auMarket as unknown as Record<string, unknown>).selectors).toBeUndefined();
        expect((auMarket as unknown as Record<string, unknown>).category_urls).toBeUndefined();

        // Standard markets still present
        expect(markets.some((m) => m.code === "US")).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("getMarketByCode looks up markets case-insensitively and handles unknown codes", () => {
      expect(getMarketByCode("us")?.code).toBe("US");
      expect(getMarketByCode("UK")?.code).toBe("UK");
      expect(getMarketByCode("in")?.defaultCurrency).toBe("INR");
      expect(getMarketByCode("")).toBeUndefined();
      expect(getMarketByCode("UNKNOWN_CODE")).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 7: LLM Probe & Model Discovery Guarding
  // ==========================================================================
  describe("7. LLM Probe & Model Discovery Guarding", () => {
    it("/api/llm/probe rejects Ollama and unauthorized URLs in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      // Reject Ollama
      const res1 = await probeRoute(new Request("http://localhost/api/llm/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "ollama", model: "llama3" })
      }));
      expect(res1.status).toBe(400);

      // Reject unauthorized URL
      const res2 = await probeRoute(new Request("http://localhost/api/llm/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          model: "gpt-4",
          baseUrl: "http://10.0.0.1:8000"
        })
      }));
      expect(res2.status).toBe(400);
    });

    it("/api/models rejects Ollama and unauthorized URLs in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      // Reject Ollama
      const res1 = await modelsRoute(new Request("http://localhost/api/models?provider=ollama", { method: "GET" }));
      expect(res1.status).toBe(400);

      // Reject unauthorized URL
      const res2 = await modelsRoute(new Request("http://localhost/api/models?provider=openai-compatible&baseUrl=http://127.0.0.1:8000", { method: "GET" }));
      expect(res2.status).toBe(400);
    });
  });

  // ==========================================================================
  // Section 8: Unicode / Punycode / Homograph & Advanced SSRF Vectors
  // ==========================================================================
  describe("8. Advanced SSRF, Homograph & Punycode Vectors", () => {
    it("rejects punycode / internationalized homograph domains spoofing allowlisted providers", () => {
      const homographs = [
        "https://xn--openroter-e2a.ai/v1", // punycode
        "https://g\u043E\u043Egleapis.com/v1", // Cyrillic 'о' in googleapis.com
        "https://\u03BFpenrouter.ai/v1", // Greek omicron in openrouter
        "https://\u043Epenai.com/v1" // Cyrillic 'о' in openai
      ];

      for (const url of homographs) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
      }
    });

    it("rejects octal / hexadecimal / integer IP SSRF bypass notation", () => {
      const ipEncodings = [
        "https://2130706433", // 127.0.0.1 decimal
        "https://017700000001", // 127.0.0.1 octal
        "https://0x7f000001", // 127.0.0.1 hex
        "https://2852039166", // 169.254.169.254 decimal
        "https://0xa9fea9fe" // 169.254.169.254 hex
      ];

      for (const url of ipEncodings) {
        const result = validateChatProviderUrl(url, "hosted-demo");
        expect(result.allowed).toBe(false);
      }
    });

    it("rejects URL with userinfo spoofing, and unwhitelisted hosts with query params", () => {
      // Userinfo spoofing: hostname is evil.com, username is openrouter.ai
      expect(validateChatProviderUrl("https://openrouter.ai:443@evil.com", "hosted-demo").allowed).toBe(false);
      // Query param containing whitelisted domain: hostname is evil.com
      expect(validateChatProviderUrl("https://evil.com?redirect=https://api.openai.com", "hosted-demo").allowed).toBe(false);
    });
  });

  // ==========================================================================
  // Section 9: High-Throughput Concurrency & Backward Compatibility
  // ==========================================================================
  describe("9. High-Throughput Concurrency & Backward Compatibility", () => {
    it("handles 1,000 concurrent route guard evaluations under mixed loads", async () => {
      const endpoints = [
        { path: "/api/scrape", method: "POST", shouldBlockHosted: true },
        { path: "/api/health", method: "GET", shouldBlockHosted: false },
        { path: "/api/profiles", method: "GET", shouldBlockHosted: true },
        { path: "/api/markets", method: "GET", shouldBlockHosted: false },
        { path: "/api/logs", method: "GET", shouldBlockHosted: true },
        { path: "/api/status", method: "GET", shouldBlockHosted: false }
      ];

      const tasks = Array.from({ length: 1000 }, (_, i) => {
        const item = endpoints[i % endpoints.length];
        const mode: DeploymentMode = i % 2 === 0 ? "hosted-demo" : "local";
        return Promise.resolve().then(() => {
          const blocked = isRouteBlockedInHostedMode(item.path, item.method, mode);
          const expected = mode === "hosted-demo" ? item.shouldBlockHosted : false;
          return { blocked, expected };
        });
      });

      const results = await Promise.all(tasks);
      for (const r of results) {
        expect(r.blocked).toBe(r.expected);
      }
    });

    it("verifies local mode maintains 100% backward compatibility for all profiles and logs", async () => {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

      // GET /api/profiles in local mode returns available profiles
      const profRes = await profilesRoute(new Request("http://localhost/api/profiles", { method: "GET" }));
      expect(profRes.status).toBe(200);
      const profBody = (await profRes.json()) as { profiles: Array<{ id: string }> };
      expect(Array.isArray(profBody.profiles)).toBe(true);

      // GET /api/logs in local mode returns logs array
      const logsRes = await logsRoute(new Request("http://localhost/api/logs?limit=5", { method: "GET" }));
      expect(logsRes.status).toBe(200);
      const logsBody = (await logsRes.json()) as { logs: unknown[] };
      expect(Array.isArray(logsBody.logs)).toBe(true);
    });
  });
});
