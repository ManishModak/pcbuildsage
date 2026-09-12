import { afterEach, describe, expect, it } from "vitest";
import { GET as getHealth } from "../route";

describe("GET /api/health", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  it("returns HTTP 200 with local mode by default", async () => {
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    const response = await getHealth();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; mode: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("local");
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("returns HTTP 200 with hosted-demo mode when configured", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const response = await getHealth();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; mode: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("hosted-demo");
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
  });
});
