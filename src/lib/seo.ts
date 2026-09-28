// Shared SEO constants. G1 owns the sitemap/robots plumbing; the guide list
// below is a stable extension point owned by G2 (guides site): append a slug
// per published guide and it appears in sitemap.xml automatically.
export const SITE_URL = "https://pcbuildsage.onrender.com";

// G2-owned: URL slugs for published guides, served under /guides/<slug>.
export const GUIDE_SLUGS: string[] = [];
