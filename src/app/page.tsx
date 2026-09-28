import { HomeClient } from "@/components/app/home-client";
import { LandingContent } from "@/components/app/landing-content";
import { pageSeo } from "@/lib/seo";

// Canonical lives here, not in the root layout, so /help pages don't inherit "/".
export const metadata = pageSeo(
  "/",
  "PCBuildSage — AI PC build planner for India",
  "PC builds from parts in stock at Indian retailers today, with exact totals, buy links and compatibility checked by code. Free and open source."
);

// Server component: the landing section below is always in the HTML so
// crawlers see real content. HomeClient swaps in the Wizard (first-time
// visitors) or ChatWorkspace (returning users) after client hydration,
// with their props and behavior unchanged.
export default function Home() {
  return <HomeClient landing={<LandingContent />} />;
}
