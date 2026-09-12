/**
 * src/lib/config/markets.ts
 *
 * Market metadata registry and dynamic market resolution.
 * Extracts public country/currency metadata without exposing internal scraper
 * configurations, selectors, or category URLs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MarketMetadata } from "./deployment";
import { STANDARD_MARKETS } from "./deployment";

export { STANDARD_MARKETS };
export type { MarketMetadata };

/**
 * Returns deduplicated market metadata for all supported regions.
 * Dynamically augments standard markets with any valid profiles found on disk,
 * strictly filtering out scraper internals, selectors, and URLs.
 */
export function listMarkets(profilesDir?: string): MarketMetadata[] {
  const dir = profilesDir ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "profiles");
  const marketsMap = new Map<string, MarketMetadata>();

  // Seed with canonical standard markets
  for (const market of STANDARD_MARKETS) {
    marketsMap.set(market.code.toUpperCase(), { ...market });
  }

  // Introspect profiles directory if accessible
  if (existsSync(dir)) {
    try {
      const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = readFileSync(path.join(dir, file), "utf8");
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.country_code === "string") {
            const code = parsed.country_code.trim().toUpperCase();
            if (/^[A-Z]{2}$/.test(code)) {
              const existing = marketsMap.get(code);
              const defaultCurrency =
                typeof parsed.default_currency === "string" && /^[A-Z]{3}$/.test(parsed.default_currency.trim().toUpperCase())
                  ? parsed.default_currency.trim().toUpperCase()
                  : existing?.defaultCurrency ?? "USD";

              let name = existing?.name;
              if (!name) {
                try {
                  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
                  name = displayNames.of(code) ?? code;
                } catch {
                  name = code;
                }
              }

              const supportedCurrencies = existing ? [...existing.supportedCurrencies] : [defaultCurrency];
              if (!supportedCurrencies.includes(defaultCurrency)) {
                supportedCurrencies.unshift(defaultCurrency);
              }

              const locale = existing?.locale ?? `en-${code}`;

              marketsMap.set(code, {
                code,
                name: name ?? code,
                defaultCurrency,
                supportedCurrencies,
                locale
              });
            }
          }
        } catch {
          // Ignore individual unparseable or inaccessible profile file
        }
      }
    } catch {
      // Ignore directory read failure
    }
  }

  return Array.from(marketsMap.values());
}

/**
 * Look up a specific market by its ISO 3166-1 alpha-2 country code.
 */
export function getMarketByCode(code: string, profilesDir?: string): MarketMetadata | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  const markets = listMarkets(profilesDir);
  return markets.find((m) => m.code === normalized);
}
