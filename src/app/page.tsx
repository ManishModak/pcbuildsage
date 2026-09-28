import { HomeClient } from "@/components/app/home-client";
import { LandingContent } from "@/components/app/landing-content";

// Server component: the landing section below is always in the HTML so
// crawlers see real content. HomeClient swaps in the Wizard (first-time
// visitors) or ChatWorkspace (returning users) after client hydration,
// with their props and behavior unchanged.
export default function Home() {
  return <HomeClient landing={<LandingContent />} />;
}
