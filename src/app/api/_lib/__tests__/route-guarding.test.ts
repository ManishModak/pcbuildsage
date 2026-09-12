import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as scrapeRoute } from "../../scrape/route";
import { GET as profilesRoute } from "../../profiles/route";
import { POST as profileImportRoute } from "../../profiles/import/route";
import { POST as profileTestRoute } from "../../profiles/test/route";
import { GET as logsRoute } from "../../logs/route";
import { POST as chatRoute } from "../../chat/route";
import { POST as probeRoute } from "../../llm/probe/route";
import { GET as modelsRoute } from "../../models/route";
import { POST as exportResearchRoute } from "../../export-research/route";
import { GET as sessionsRoute } from "../../sessions/route";

describe("Route Guarding & Defense-in-Depth Integration", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
    vi.restoreAllMocks();
  });

  describe("In hosted-demo mode", () => {
    it("blocks POST /api/scrape with HTTP 403", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/scrape", {
        method: "POST",
        body: JSON.stringify({ profile: "india" })
      });
      const response = await scrapeRoute(request);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });

    it("blocks GET /api/profiles with HTTP 403", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/profiles", { method: "GET" });
      const response = await profilesRoute(request);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });

    it("blocks POST /api/profiles/import with HTTP 403", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/profiles/import", {
        method: "POST",
        body: JSON.stringify({ profile: {} })
      });
      const response = await profileImportRoute(request);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });

    it("blocks POST /api/profiles/test with HTTP 403", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/profiles/test", {
        method: "POST",
        body: JSON.stringify({ profile: "india" })
      });
      const response = await profileTestRoute(request);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });

    it("blocks GET /api/logs with HTTP 403", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/logs", { method: "GET" });
      const response = await logsRoute(request);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });

    it("blocks POST /api/export-research with HTTP 403 in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/export-research", {
        method: "POST",
        body: JSON.stringify({})
      });
      const response = await exportResearchRoute(request);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });

    it("blocks GET /api/sessions with HTTP 403 in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const response = await sessionsRoute();
      expect(response.status).toBe(403);
    });

    it("rejects POST /api/chat when ollama provider is specified in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [{ provider: "ollama", model: "llama3" }]
          }
        })
      });
      const response = await chatRoute(request);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toContain("ollama");
    });

    it("rejects POST /api/chat when malicious or private baseUrl is specified in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          config: {
            llmChain: [
              {
                provider: "openai-compatible",
                model: "gpt-4",
                baseUrl: "http://169.254.169.254/latest/meta-data"
              }
            ]
          }
        })
      });
      const response = await chatRoute(request);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("invalid_request");
    });

    it("rejects POST /api/llm/probe with unauthorized baseUrl in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/llm/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          model: "gpt-4",
          baseUrl: "http://127.0.0.1:8000"
        })
      });
      const response = await probeRoute(request);
      expect(response.status).toBe(400);
    });

    it("rejects GET /api/models with unauthorized baseUrl in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      const request = new Request("http://localhost/api/models?provider=openai-compatible&baseUrl=http://10.0.0.1", {
        method: "GET"
      });
      const response = await modelsRoute(request);
      expect(response.status).toBe(400);
    });
  });

  describe("In local mode", () => {
    it("permits GET /api/profiles in local mode", async () => {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
      const request = new Request("http://localhost/api/profiles", { method: "GET" });
      const response = await profilesRoute(request);
      expect(response.status).toBe(200);
    });

    it("permits GET /api/logs in local mode", async () => {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
      const request = new Request("http://localhost/api/logs", { method: "GET" });
      const response = await logsRoute(request);
      expect(response.status).toBe(200);
    });
  });
});
