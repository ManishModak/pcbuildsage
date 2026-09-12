import { afterEach, describe, expect, it } from "vitest";
import { guardHostedRoute, createForbiddenResponse } from "../route-guard";

describe("Route Guard Middleware Helper", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  it("returns null in default local mode", () => {
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    expect(guardHostedRoute()).toBeNull();
  });

  it("returns 403 response in hosted-demo mode", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const res = guardHostedRoute();
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    const body = (await res?.json()) as { error: string; message: string; code: string };
    expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
    expect(body.message).toContain("hosted demo mode");
  });

  it("createForbiddenResponse customizes forbidden message", async () => {
    const res = createForbiddenResponse("Custom blocked message");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string; code: string };
    expect(body.message).toBe("Custom blocked message");
    expect(body.code).toBe("HOSTED_DEMO_FORBIDDEN");
  });
});
