// Amazon Associates search links shown next to each part on the build card.
// Amazon's rules allow tagged links but not prices we didn't get from its API,
// so these links carry no price. Keyed by currency because the card knows the
// build's currency, not its market; each currency here belongs to one market.
const AMAZON_STORES: Record<string, { host: string; tag: string }> = {
  INR: { host: "www.amazon.in", tag: "pcbuildsage-21" }
};

// Amazon requires this exact sentence wherever its affiliate links appear.
export const AMAZON_DISCLOSURE = "As an Amazon Associate I earn from qualifying purchases.";

// Search URL for a part on the Amazon store for this currency, or null when
// there is no store for it or the name is empty.
export function amazonSearchUrl(name: string, currency: string): string | null {
  const store = AMAZON_STORES[currency];
  const query = name.replace(/\s+/g, " ").trim();
  if (!store || !query) return null;
  const url = new URL(`https://${store.host}/s`);
  url.searchParams.set("k", query);
  url.searchParams.set("tag", store.tag);
  return url.toString();
}
