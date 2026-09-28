import type { MetadataRoute } from "next";
import { GUIDE_SLUGS, SITE_URL } from "@/lib/seo";

// Static app routes. Guide URLs come from GUIDE_SLUGS (G2-owned extension
// point in src/lib/seo.ts) — G2 fills that list, no changes needed here.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const staticRoutes = ["/", "/help", "/help/api-key"];
  return [
    ...staticRoutes.map((route) => ({
      url: `${SITE_URL}${route}`,
      lastModified
    })),
    ...GUIDE_SLUGS.map((slug) => ({
      url: `${SITE_URL}/guides/${slug}`,
      lastModified
    }))
  ];
}
