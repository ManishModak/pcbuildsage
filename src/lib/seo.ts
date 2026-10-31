import type { Metadata } from "next";

// Shared SEO constants and per-page metadata helper.
export const SITE_URL = "https://pcbuildsage.onrender.com";

/**
 * Per-page title, description, canonical and Open Graph metadata. Each crawlable page calls this
 * with its own path so no page inherits another page's canonical (Next.js
 * replaces, not merges, a child's `openGraph`, so the shared fields live here).
 */
export function pageSeo(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: "PCBuildSage", url: path, title, description }
  };
}
