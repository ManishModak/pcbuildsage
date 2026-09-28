import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { metadata as apiKeyHelpMetadata } from "@/app/help/api-key/page";
import { metadata as helpMetadata } from "@/app/help/page";
import { metadata as rootMetadata } from "@/app/layout";
import Home, { metadata as homeMetadata } from "@/app/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { AppProvider } from "@/components/app/app-provider";
import { SITE_URL } from "@/lib/seo";

// The root layout loads Google fonts at module scope; stub them for Node.
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "" }),
  JetBrains_Mono: () => ({ variable: "" })
}));

// Crawler-style: static markup with no JS and no effects — exactly what a
// search crawler sees for `/` (client hydration never runs).
function crawlerHtml(): string {
  return renderToStaticMarkup(
    <AppProvider>
      <Home />
    </AppProvider>
  );
}

describe("G1 search basics: crawler-visible landing on /", () => {
  it("server HTML contains the landing copy, not just a spinner", () => {
    const html = crawlerHtml();
    expect(html).toContain("PCBuildSage");
    expect(html).toContain("Indian retailers");
    expect(html).toContain("Exact totals");
    expect(html).toContain("Buy links");
    expect(html).toMatch(/compatib/i);
    expect(html).toMatch(/checked by (code|a .*rules engine)/);
    expect(html).toMatch(/open source/i);
    expect(html).toContain("API key");
    expect(html).toContain('href="/help"');
    // Guides placeholder link (content owned by G2).
    expect(html).toContain("guides");
  });

  it("never calls any build 'best'", () => {
    expect(crawlerHtml().toLowerCase()).not.toContain("best");
  });
});

describe("G1 search basics: robots and sitemap", () => {
  it("robots allows / and points at the onrender sitemap", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: `${SITE_URL}/sitemap.xml`
    });
  });

  it("sitemap lists the static routes", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([`${SITE_URL}/`, `${SITE_URL}/help`, `${SITE_URL}/help/api-key`]);
  });
});

describe("per-page canonical", () => {
  it("root layout sets no canonical or og:url, so pages don't inherit '/'", () => {
    expect(rootMetadata.alternates?.canonical).toBeUndefined();
    expect((rootMetadata.openGraph as { url?: unknown } | undefined)?.url).toBeUndefined();
  });

  it.each([
    ["/", homeMetadata],
    ["/help", helpMetadata],
    ["/help/api-key", apiKeyHelpMetadata]
  ])("%s has its own canonical and og:url", (path, metadata) => {
    expect(metadata.alternates?.canonical).toBe(path);
    expect((metadata.openGraph as { url?: unknown } | undefined)?.url).toBe(path);
    expect(metadata.title).toBeTruthy();
  });
});
