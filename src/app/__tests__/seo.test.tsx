import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { AppProvider } from "@/components/app/app-provider";
import { GUIDE_SLUGS, SITE_URL } from "@/lib/seo";

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

  it("sitemap lists static routes plus one entry per G2 guide slug", () => {
    const entries = sitemap();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain(`${SITE_URL}/`);
    expect(urls).toContain(`${SITE_URL}/help`);
    expect(urls).toContain(`${SITE_URL}/help/api-key`);
    for (const slug of GUIDE_SLUGS) {
      expect(urls).toContain(`${SITE_URL}/guides/${slug}`);
    }
    expect(entries.length).toBe(3 + GUIDE_SLUGS.length);
  });

  it("exposes a stable guide-slug extension point for G2", () => {
    expect(Array.isArray(GUIDE_SLUGS)).toBe(true);
  });
});
