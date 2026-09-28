import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

// Static app routes. Build guides are published separately to GitHub Pages
// (scripts/build-guides.ts), so they are not part of this sitemap.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const staticRoutes = ["/", "/help", "/help/api-key"];
  return staticRoutes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified
  }));
}
