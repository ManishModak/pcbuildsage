import { describe, expect, it } from "vitest";
import {
  crawlPage,
  assertCrawlUrlAllowed,
  preflightCrawlUrl,
  isPrivateCrawlHost,
  isPrivateAddress,
  type CrawlLookup,
  CRAWLED_PAGE_CAP_CHARS,
} from "@/lib/web-search";

describe("crawl URL allow-list", () => {
  it("allows public http/https", () => {
    expect(() => assertCrawlUrlAllowed("https://example.com/specs")).not.toThrow();
    expect(() => assertCrawlUrlAllowed("http://specs.example.com/x")).not.toThrow();
  });

  it("rejects non-http schemes", () => {
    expect(() => assertCrawlUrlAllowed("ftp://example.com/x")).toThrow(/only http\/https/);
    expect(() => assertCrawlUrlAllowed("file:///etc/passwd")).toThrow(/only http\/https/);
  });

  it("blocks private and loopback literals", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.4.1", "172.31.255.1", "192.168.1.1", "0.0.0.0"]) {
      expect(isPrivateCrawlHost(host)).toBe(true);
      expect(() => assertCrawlUrlAllowed(`http://${host}/`)).toThrow(/private or loopback/);
    }
    expect(isPrivateCrawlHost("::1")).toBe(true);
    expect(() => assertCrawlUrlAllowed("http://[::1]/")).toThrow(/private or loopback/);
    // Public boundaries stay allowed.
    expect(isPrivateCrawlHost("172.15.0.1")).toBe(false);
    expect(isPrivateCrawlHost("172.32.0.1")).toBe(false);
  });

  it("blocks CGNAT, IPv4-mapped IPv6 and unique-local literals", () => {
    for (const addr of ["100.64.0.1", "100.127.255.254", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "fd12::1", "fe80::1", "64:ff9b::a9fe:a9fe"]) {
      expect(isPrivateAddress(addr)).toBe(true);
    }
    expect(() => assertCrawlUrlAllowed("http://[::ffff:169.254.169.254]/latest/meta-data")).toThrow(/private or loopback/);
    expect(isPrivateAddress("100.128.0.1")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});

// nip.io-style names: public-looking hostnames whose DNS answers are private.
const fakeDns: Record<string, string[]> = {
  "example.com": ["93.184.215.14"],
  "127.0.0.1.nip.io": ["127.0.0.1"],
  "mixed.example.com": ["93.184.215.14", "::ffff:169.254.169.254"],
  "cgnat.example.com": ["100.64.1.1"]
};
const lookup: CrawlLookup = async (host) => {
  const addresses = fakeDns[host];
  if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const okFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

describe("crawl pre-flight (DNS + redirects)", () => {
  it("rejects hostnames that resolve to private addresses (any answer)", async () => {
    await expect(preflightCrawlUrl("http://127.0.0.1.nip.io/", undefined, { lookup, fetchImpl: okFetch })).rejects.toThrow(/resolves to private/);
    await expect(preflightCrawlUrl("https://mixed.example.com/", undefined, { lookup, fetchImpl: okFetch })).rejects.toThrow(/169\.254\.169\.254/);
    await expect(preflightCrawlUrl("https://cgnat.example.com/", undefined, { lookup, fetchImpl: okFetch })).rejects.toThrow(/resolves to private/);
  });

  it("allows a public host and returns the final URL", async () => {
    await expect(preflightCrawlUrl("https://example.com/specs", undefined, { lookup, fetchImpl: okFetch })).resolves.toBe("https://example.com/specs");
  });

  it("checks every redirect hop, including DNS of the target", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      if (url === "https://example.com/start") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1.nip.io/secret" } });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(preflightCrawlUrl("https://example.com/start", undefined, { lookup, fetchImpl })).rejects.toThrow(/resolves to private/);
  });

  it("blocks literal private redirect targets", async () => {
    const fetchImpl = (async (url: string) =>
      url === "https://example.com/start"
        ? new Response(null, { status: 301, headers: { location: "http://[::ffff:127.0.0.1]/" } })
        : new Response("ok")) as unknown as typeof fetch;
    await expect(preflightCrawlUrl("https://example.com/start", undefined, { lookup, fetchImpl })).rejects.toThrow(/private or loopback/);
  });

  it("caps redirects at 5 hops", async () => {
    let hops = 0;
    const fetchImpl = (async () => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: `https://example.com/r${hops}` } });
    }) as unknown as typeof fetch;
    await expect(preflightCrawlUrl("https://example.com/r0", undefined, { lookup, fetchImpl })).rejects.toThrow(/more than 5 redirects/);
    expect(hops).toBe(6);
  });

  it("fails closed when DNS or the pre-flight request fails", async () => {
    await expect(preflightCrawlUrl("https://unknown.example.org/", undefined, { lookup, fetchImpl: okFetch })).rejects.toThrow(/could not resolve/);
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(preflightCrawlUrl("https://example.com/", undefined, { lookup, fetchImpl: failing })).rejects.toThrow(/pre-flight request .* failed/);
  });

  it("crawlPage runs the pre-flight before the crawler and blocks on failure", async () => {
    let called = false;
    const runner = async () => {
      called = true;
      return { code: 0, signal: null, stdout: "x", stderr: "" };
    };
    const preflight = (url: string, signal?: AbortSignal) => preflightCrawlUrl(url, signal, { lookup, fetchImpl: okFetch }).then(() => undefined);
    await expect(crawlPage("http://127.0.0.1.nip.io/", runner, { preflight })).rejects.toThrow(/resolves to private/);
    expect(called).toBe(false);
  });

  it("passes preflight-resolved redirect target to the crawl runner", async () => {
    let targetArg = "";
    const runner = async (_mod: string, args: string[]) => {
      targetArg = args[0];
      return { code: 0, signal: null, stdout: "page text", stderr: "" };
    };
    const preflight = async () => "https://example.com/final-destination";
    const res = await crawlPage("https://example.com/initial-redirect", runner, { preflight });
    expect(res).toBe("page text");
    expect(targetArg).toBe("https://example.com/final-destination");
  });
});

describe("crawlPage cap", () => {
  it("caps each page at ~20k chars before the subagent", async () => {
    expect(CRAWLED_PAGE_CAP_CHARS).toBeLessThanOrEqual(20_000);
    const big = "x".repeat(50_000);
    const runner = async () => ({ code: 0, signal: null, stdout: big, stderr: "" });
    const content = await crawlPage("https://example.com/big", runner, { preflight: async () => {} });
    expect(content.length).toBe(CRAWLED_PAGE_CAP_CHARS);
  });

  it("rejects private URLs without invoking the runner", async () => {
    let called = false;
    const runner = async () => {
      called = true;
      return { code: 0, signal: null, stdout: "x", stderr: "" };
    };
    await expect(crawlPage("http://127.0.0.1/secret", runner)).rejects.toThrow(/private or loopback/);
    expect(called).toBe(false);
  });

  it("is abortable via signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = async (_module: string, _args: string[], options: { signal?: AbortSignal }) => {
      if (options.signal?.aborted) throw new Error("Page crawl was cancelled.");
      return { code: 0, signal: null, stdout: "x", stderr: "" };
    };
    await expect(crawlPage("https://example.com/x", runner, { signal: controller.signal })).rejects.toThrow(/cancelled/);
  });
});

describe("crawl domain deny list & robots.txt", () => {
  it("blocks forbidden domains in assertCrawlUrlAllowed", () => {
    for (const host of ["tomshardware.com", "sub.tomshardware.com", "techpowerup.com", "3dcenter.org", "techradar.com"]) {
      expect(() => assertCrawlUrlAllowed(`https://${host}/reviews`)).toThrow(/forbidden by terms or anti-scraping policy/);
    }
    expect(() => assertCrawlUrlAllowed("https://amd.com/en/products")).not.toThrow();
  });

  it("blocks a robots.txt-disallowed path without following redirects", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      if (url === "https://example.com/robots.txt") return new Response("User-agent: *\nDisallow: /private/", { status: 200 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(preflightCrawlUrl("https://example.com/private/doc", undefined, { lookup, fetchImpl })).rejects.toThrow(/robots\.txt/);
    await expect(preflightCrawlUrl("https://example.com/specs", undefined, { lookup, fetchImpl })).resolves.toBe("https://example.com/specs");
  });

  it("evaluates robots.txt path restrictions accurately", async () => {
    const { isPathDisallowedByRobotsTxt } = await import("@/lib/web-search");
    const robots = `
User-agent: Googlebot
Disallow: /admin

User-agent: *
Disallow: /private/
Disallow: /api/secret
`;
    expect(isPathDisallowedByRobotsTxt(robots, "/private/doc")).toBe(true);
    expect(isPathDisallowedByRobotsTxt(robots, "/api/secret/key")).toBe(true);
    expect(isPathDisallowedByRobotsTxt(robots, "/public/specs")).toBe(false);
  });
});
