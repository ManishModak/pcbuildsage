/**
 * src/types/catalog.ts
 *
 * Domain types for PCBuildSage catalog offers, market preferences,
 * and multi-region pricing representations.
 */

/**
 * Valid ingestion / origin sources for a product offer.
 * Supports source-neutral aggregation across scraped HTML pages, direct retailer feeds,
 * manual corrections, and affiliate programs.
 */
export type OfferSourceType = "scraped" | "retailer-feed" | "manual" | "affiliate";

/**
 * Standardized stock / availability status for a product offer.
 */
export type OfferAvailability =
  | "in_stock"
  | "out_of_stock"
  | "preorder"
  | "backorder"
  | "discontinued"
  | "unknown";

/**
 * Normalized source-neutral offer model representing a purchasable listing
 * for a hardware product from a specific retailer in a specific target market.
 *
 * Maintains native currency and pricing integrity without premature lossy conversions.
 */
export interface ProductOffer {
  /** Optional offer identifier in database */
  id?: number | string;

  /** Canonical product identifier */
  productId: string;

  /** Standard retailer identifier (e.g., "microcenter", "amazon-in") */
  retailerId?: string;

  /** Human-readable retailer display name (e.g., "MicroCenter", "MDComputers") */
  retailer?: string;

  /** ISO 3166-1 alpha-2 country code where this offer is valid (e.g., "US", "IN") */
  countryCode: string;

  /** ISO 4217 currency code of the retailer's native price (e.g., "USD", "INR") */
  currencyCode: string;

  /** Price in standard major currency units (e.g. 249.99 USD, 35000 INR), or null if unpriced */
  price: number | null;

  /** Price in minor currency units (e.g., cents or paise: 24999, 3500000) */
  priceMinor?: number;

  /** Canonical product destination URL at the retailer */
  destinationUrl: string;

  /** Origin source of this offer */
  sourceType: OfferSourceType;

  /** ISO 8601 timestamp when this offer was observed/scraped */
  observedAt?: string;

  /** Availability state */
  availability?: OfferAvailability | (string & {});

  /** Boolean flag indicating if product is currently in stock (for backward compatibility) */
  inStock?: boolean;

  /** ISO 8601 timestamp when this offer was last updated (for backward compatibility) */
  lastUpdated?: string;

  /** Optional image URL specific to this retailer listing */
  imageUrl?: string | null;
}

/**
 * User-selected market preference for catalog filtering and currency display.
 * Stored client-side (in browser) and isolated per visitor.
 */
export interface MarketPreference {
  /** ISO 3166-1 alpha-2 country code (e.g. "US", "IN", "UK", "CA", "DE") */
  countryCode: string;

  /** ISO 4217 currency code preferred for display (e.g. "USD", "INR", "GBP") */
  currencyCode: string;

  /** BCP 47 locale tag for number and currency formatting (e.g. "en-US", "en-IN") */
  locale: string;
}

/** Zero-decimal ISO 4217 currency codes */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "BIF", "DJF", "GNF", "KMF", "RWF", "UGX"]);

/**
 * Helper to convert standard major currency price to integer minor units (cents/paise).
 * e.g. $249.99 -> 24999, ₹35,000 -> 3500000, ¥5000 -> 5000.
 */
export function toPriceMinor(price: number, currencyCode?: string): number {
  if (currencyCode && ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())) {
    return Math.round(price);
  }
  return Math.round(price * 100);
}

/**
 * Helper to convert integer minor units (cents/paise) back to standard major price.
 * e.g. 24999 -> 249.99, 3500000 -> 35000.
 */
export function fromPriceMinor(priceMinor: number, currencyCode?: string): number {
  if (currencyCode && ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())) {
    return priceMinor;
  }
  return priceMinor / 100;
}

/**
 * Helper to check if an offer is in stock, evaluating both `inStock` boolean and `availability` status.
 */
export function isOfferInStock(offer: ProductOffer): boolean {
  if (typeof offer.inStock === "boolean") {
    return offer.inStock;
  }
  if (offer.availability) {
    return offer.availability === "in_stock" || offer.availability === "preorder";
  }
  return true;
}
