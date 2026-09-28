import { describe, expect, it } from "vitest";
import {
  crawlPage,
  assertCrawlUrlAllowed,
  assertRedirectChainAllowed,
  isPrivateCrawlHost,
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

  it("blocks redirect hops to private addresses", async () => {
    const fetchMock = (async (url: string) => {
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await expect(assertRedirectChainAllowed("https://example.com/start", fetchMock)).rejects.toThrow(/private or loopback/);
  });
});

describe("crawlPage cap", () => {
  it("caps each page at ~20k chars before the subagent", async () => {
    expect(CRAWLED_PAGE_CAP_CHARS).toBeLessThanOrEqual(20_000);
    const big = "x".repeat(50_000);
    const runner = async () => ({ code: 0, signal: null, stdout: big, stderr: "" });
    const content = await crawlPage("https://example.com/big", runner);
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
