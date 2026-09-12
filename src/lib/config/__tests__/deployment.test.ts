import { afterEach, describe, expect, it } from "vitest";
import {
  getDeploymentMode,
  getSupportedMarkets,
  isHostedDemo,
  isLocal,
  isRouteBlockedInHostedMode,
  normalizeRoutePath,
  validateChatProviderUrl,
  validateSearchBaseUrl
} from "../deployment";

describe("Deployment Config & Mode Detection", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  it("defaults safely to 'local' when environment variable is unset", () => {
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    expect(getDeploymentMode()).toBe("local");
    expect(isHostedDemo()).toBe(false);
    expect(isLocal()).toBe(true);
  });

  it("resolves to 'hosted-demo' when PCBUILDSAGE_DEPLOYMENT_MODE is set", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    expect(getDeploymentMode()).toBe("hosted-demo");
    expect(isHostedDemo()).toBe(true);
    expect(isLocal()).toBe(false);
  });

  it("handles whitespace trimming and case insensitivity", () => {
    expect(getDeploymentMode("  hosted-demo  ")).toBe("hosted-demo");
    expect(getDeploymentMode("HOSTED-DEMO")).toBe("hosted-demo");
    expect(getDeploymentMode("  Hosted-Demo ")).toBe("hosted-demo");
    expect(getDeploymentMode("LOCAL")).toBe("local");
    expect(getDeploymentMode(" local ")).toBe("local");
  });

  it("falls back to 'local' for unrecognized strings or empty strings", () => {
    expect(getDeploymentMode("")).toBe("local");
    expect(getDeploymentMode("production")).toBe("local");
    expect(getDeploymentMode("staging")).toBe("local");
    expect(getDeploymentMode("arbitrary-mode")).toBe("local");
    expect(getDeploymentMode(undefined)).toBe("local");
  });

  it("accepts custom env object parameter", () => {
    expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe("hosted-demo");
    expect(isHostedDemo({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe(true);
    expect(isLocal({ PCBUILDSAGE_DEPLOYMENT_MODE: "hosted-demo" })).toBe(false);

    expect(getDeploymentMode({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe("local");
    expect(isHostedDemo({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe(false);
    expect(isLocal({ PCBUILDSAGE_DEPLOYMENT_MODE: "local" })).toBe(true);
  });
});

describe("normalizeRoutePath", () => {
  it("resolves dot segments and relative paths", () => {
    expect(normalizeRoutePath("/api/./scrape")).toBe("/api/scrape");
    expect(normalizeRoutePath("/api/../api/scrape")).toBe("/api/scrape");
    expect(normalizeRoutePath("/foo/bar/../../api/logs")).toBe("/api/logs");
  });

  it("deduplicates repeated consecutive slashes", () => {
    expect(normalizeRoutePath("//api//scrape")).toBe("/api/scrape");
    expect(normalizeRoutePath("///api///profiles///")).toBe("/api/profiles");
  });

  it("strips query strings and URL hashes", () => {
    expect(normalizeRoutePath("/api/markets?refresh=true&country=US")).toBe("/api/markets");
    expect(normalizeRoutePath("/api/scrape#section")).toBe("/api/scrape");
  });

  it("decodes URL-encoded path segments", () => {
    expect(normalizeRoutePath("%2fapi%2fscrape")).toBe("/api/scrape");
    expect(normalizeRoutePath("/api/%73crape")).toBe("/api/scrape");
    expect(normalizeRoutePath("/api/%70rofiles/%69mport")).toBe("/api/profiles/import");
  });

  it("handles empty or root path", () => {
    expect(normalizeRoutePath("")).toBe("/");
    expect(normalizeRoutePath("/")).toBe("/");
  });
});

describe("isRouteBlockedInHostedMode", () => {
  it("allows all routes and methods in local mode", () => {
    expect(isRouteBlockedInHostedMode("/api/scrape", "POST", "local")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/profiles", "GET", "local")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/profiles/import", "POST", "local")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/profiles/test", "POST", "local")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/logs", "GET", "local")).toBe(false);
  });

  it("blocks dangerous routes in hosted-demo mode", () => {
    expect(isRouteBlockedInHostedMode("/api/scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/scrape", "GET", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/profiles", "GET", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/profiles/import", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/profiles/test", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/logs", "GET", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/logs", "DELETE", "hosted-demo")).toBe(true);
  });

  it("blocks subpaths and trailing slashes in hosted-demo mode", () => {
    expect(isRouteBlockedInHostedMode("/api/scrape///", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/profiles/sub/custom", "GET", "hosted-demo")).toBe(true);
  });

  it("blocks double slashes and dot-traversals in hosted-demo mode", () => {
    expect(isRouteBlockedInHostedMode("//api/scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("//api//scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/./scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/../api/scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/other/../api/logs", "GET", "hosted-demo")).toBe(true);
  });

  it("handles URL encoding safely in hosted-demo mode", () => {
    expect(isRouteBlockedInHostedMode("/api/%73crape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/%70rofiles", "GET", "hosted-demo")).toBe(true);
  });

  it("permits safe public endpoints in hosted-demo mode", () => {
    expect(isRouteBlockedInHostedMode("/api/health", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/markets", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/status", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/chat", "POST", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/config", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/themes", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/personalities", "GET", "hosted-demo")).toBe(false);
  });

  it("permits safe routes with query params in hosted-demo mode", () => {
    expect(isRouteBlockedInHostedMode("/api/markets?refresh=true", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlockedInHostedMode("/api/status?detail=true", "GET", "hosted-demo")).toBe(false);
  });
});

describe("validateChatProviderUrl", () => {
  it("allows any valid URL or undefined in local mode", () => {
    expect(validateChatProviderUrl(undefined, "local").allowed).toBe(true);
    expect(validateChatProviderUrl("", "local").allowed).toBe(true);
    expect(validateChatProviderUrl("http://localhost:11434", "local").allowed).toBe(true);
    expect(validateChatProviderUrl("http://127.0.0.1:8000", "local").allowed).toBe(true);
    expect(validateChatProviderUrl("http://192.168.1.100:8080", "local").allowed).toBe(true);
    expect(validateChatProviderUrl("https://custom.lan/v1", "local").allowed).toBe(true);
  });

  it("allows undefined or empty in hosted-demo mode", () => {
    expect(validateChatProviderUrl(undefined, "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("", "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("   ", "hosted-demo").allowed).toBe(true);
  });

  it("allows official cloud provider HTTPS URLs in hosted-demo mode", () => {
    expect(validateChatProviderUrl("https://generativelanguage.googleapis.com", "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("https://openrouter.ai/api/v1", "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("https://api.openai.com/v1", "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("https://api.anthropic.com/v1", "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("https://api.groq.com/openai/v1", "hosted-demo").allowed).toBe(true);
    expect(validateChatProviderUrl("https://api.deepseek.com/v1", "hosted-demo").allowed).toBe(true);
  });

  it("rejects non-HTTPS protocols in hosted-demo mode", () => {
    expect(validateChatProviderUrl("http://generativelanguage.googleapis.com", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("ftp://openrouter.ai", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("ws://api.openai.com", "hosted-demo").allowed).toBe(false);
  });

  it("rejects loopback, private IPs, and IMDS in hosted-demo mode", () => {
    expect(validateChatProviderUrl("http://127.0.0.1:8000", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://127.0.0.1", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("http://localhost:3000", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://localhost", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("http://169.254.169.254/latest/meta-data", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://169.254.169.254", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://10.0.0.1/v1", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://192.168.1.1/v1", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://172.20.0.1/v1", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("http://[::1]:8000", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://server.local", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://internal.service.internal", "hosted-demo").allowed).toBe(false);
  });

  it("rejects embedded basic auth credentials in hosted-demo mode", () => {
    expect(validateChatProviderUrl("https://user:pass@openrouter.ai/v1", "hosted-demo").allowed).toBe(false);
  });

  it("rejects custom ports in hosted-demo mode", () => {
    expect(validateChatProviderUrl("https://openrouter.ai:8443/v1", "hosted-demo").allowed).toBe(false);
  });

  it("rejects unauthorized domains and subdomain spoofing in hosted-demo mode", () => {
    expect(validateChatProviderUrl("https://attacker-domain.com/v1", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://generativelanguage.googleapis.com.attacker.com/v1", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("https://openrouter.ai.evil.com", "hosted-demo").allowed).toBe(false);
  });

  it("rejects malformed strings safely without throwing in hosted-demo mode", () => {
    expect(validateChatProviderUrl("not-a-valid-url", "hosted-demo").allowed).toBe(false);
    expect(validateChatProviderUrl("://broken", "hosted-demo").allowed).toBe(false);
  });
});

describe("validateSearchBaseUrl", () => {
  it("allows any valid URL or empty in local mode", () => {
    expect(validateSearchBaseUrl(undefined, "local").allowed).toBe(true);
    expect(validateSearchBaseUrl("", "local").allowed).toBe(true);
    expect(validateSearchBaseUrl("http://localhost:8080", "local").allowed).toBe(true);
    expect(validateSearchBaseUrl("http://127.0.0.1:8888", "local").allowed).toBe(true);
  });

  it("allows official search provider HTTPS URLs in hosted-demo mode", () => {
    expect(validateSearchBaseUrl(undefined, "hosted-demo").allowed).toBe(true);
    expect(validateSearchBaseUrl("", "hosted-demo").allowed).toBe(true);
    expect(validateSearchBaseUrl("https://html.duckduckgo.com", "hosted-demo").allowed).toBe(true);
    expect(validateSearchBaseUrl("https://api.search.brave.com", "hosted-demo").allowed).toBe(true);
    expect(validateSearchBaseUrl("https://api.exa.ai", "hosted-demo").allowed).toBe(true);
    expect(validateSearchBaseUrl("https://api.tavily.com", "hosted-demo").allowed).toBe(true);
  });

  it("rejects non-HTTPS, loopback, private IPs, and IMDS in hosted-demo mode", () => {
    expect(validateSearchBaseUrl("http://html.duckduckgo.com", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("http://localhost:8080", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("https://127.0.0.1:8080", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("http://169.254.169.254", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("https://10.0.0.1", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("https://192.168.1.1", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("https://evil.com/search", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("https://user:pass@html.duckduckgo.com", "hosted-demo").allowed).toBe(false);
    expect(validateSearchBaseUrl("https://html.duckduckgo.com:8443", "hosted-demo").allowed).toBe(false);
  });
});

describe("Market Metadata Registry", () => {
  it("provides standard market constants", () => {
    const markets = getSupportedMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(5);
    const codes = markets.map((m) => m.code);
    expect(codes).toContain("US");
    expect(codes).toContain("UK");
    expect(codes).toContain("IN");
    expect(codes).toContain("CA");
    expect(codes).toContain("DE");
  });
});
