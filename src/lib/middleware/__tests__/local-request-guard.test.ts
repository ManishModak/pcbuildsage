import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedHostsFromEnv, localRequestRejection } from "../local-request-guard";

const headers = (values: Record<string, string>) => new Headers(values);

describe("localRequestRejection", () => {
  it("allows the app's own tab and non-browser clients on loopback hosts", () => {
    expect(localRequestRejection(headers({ host: "localhost:3000", "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }))).toBeNull();
    expect(localRequestRejection(headers({ host: "127.0.0.1:3000" }))).toBeNull();
    expect(localRequestRejection(headers({ host: "[::1]:3000", "sec-fetch-site": "none" }))).toBeNull();
    expect(localRequestRejection(headers({ host: "app.localhost:3000" }))).toBeNull();
  });

  it("refuses another website driving the API, e.g. an <img> GET that would send .env keys elsewhere", () => {
    expect(localRequestRejection(headers({ host: "localhost:3000", "sec-fetch-site": "cross-site" }))).toMatch(/Cross-site/);
    // Another app on a different localhost port is same-site, not same-origin.
    expect(localRequestRejection(headers({ host: "localhost:3000", "sec-fetch-site": "same-site" }))).toMatch(/Cross-site/);
  });

  it("refuses a foreign Origin from browsers that don't send Sec-Fetch-Site", () => {
    expect(localRequestRejection(headers({ host: "localhost:3000", origin: "https://evil.example" }))).toMatch(/Cross-origin/);
    expect(localRequestRejection(headers({ host: "localhost:3000", origin: "null" }))).toMatch(/Cross-origin/);
    expect(localRequestRejection(headers({ host: "localhost:3000", origin: "http://localhost:4000" }))).toMatch(/Cross-origin/);
  });

  it("refuses non-loopback hosts, which is what a DNS-rebinding page sends", () => {
    expect(localRequestRejection(headers({ host: "rebind.evil.example:3000", "sec-fetch-site": "same-origin" }))).toMatch(/not allowed/);
    expect(localRequestRejection(headers({ host: "192.168.1.20:3000" }))).toMatch(/not allowed/);
    expect(localRequestRejection(headers({}))).toMatch(/not allowed/);
  });

  it("lets PCBUILDSAGE_ALLOWED_HOSTS opt in LAN hosts", () => {
    const allowed = allowedHostsFromEnv({ PCBUILDSAGE_ALLOWED_HOSTS: " Desk.lan , 192.168.1.20 " } as unknown as NodeJS.ProcessEnv);
    expect(allowed).toEqual(["desk.lan", "192.168.1.20"]);
    expect(localRequestRejection(headers({ host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" }), allowed)).toBeNull();
  });
});

describe("middleware wiring", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 403 for a cross-site local request and leaves hosted mode to its own guard", async () => {
    const { middleware } = await import("@/middleware");
    const { NextRequest } = await import("next/server");
    const crossSite = () =>
      new NextRequest("http://localhost:3000/api/models?provider=groq&baseUrl=https://evil.example", {
        headers: { host: "localhost:3000", "sec-fetch-site": "cross-site" }
      });

    vi.stubEnv("PCBUILDSAGE_DEPLOYMENT_MODE", "local");
    const blocked = middleware(crossSite());
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { code: string }).code).toBe("LOCAL_REQUEST_FORBIDDEN");

    vi.stubEnv("PCBUILDSAGE_DEPLOYMENT_MODE", "hosted-demo");
    expect(middleware(crossSite()).status).toBe(200);
  });
});
