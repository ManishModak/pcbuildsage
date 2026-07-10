// Formatting helpers. Prices are integer minor units everywhere in the API;
// these render them for display. Kept framework-agnostic and unit-tested.

const CURRENCY_MINOR_DIGITS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0
};

export function minorDigits(currency: string): number {
  return CURRENCY_MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/**
 * Format an integer minor-unit price (e.g. paise, cents) for the given currency.
 * Returns a plain string; callers render it in mono with tabular-nums.
 */
export function formatPrice(
  minor: number | null | undefined,
  currency: string,
  locale?: string
): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return "—";
  const digits = minorDigits(currency);
  const major = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(major);
  } catch {
    // Unknown currency code: fall back to a symbol-less grouped number.
    return `${currency.toUpperCase()} ${major.toLocaleString(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    })}`;
  }
}

export function sumPrices(prices: Array<number | null | undefined>): number {
  return prices.reduce<number>((total, price) => total + (typeof price === "number" ? price : 0), 0);
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.round((then - now) / 1000);
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1]
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (abs >= seconds) {
      return rtf.format(Math.round(diff / seconds), unit);
    }
  }
  return rtf.format(diff, "second");
}

export function formatClock(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sameDay = new Date(then).toDateString() === new Date(now).toDateString();
  return new Date(then).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "short", day: "numeric" })
  });
}

/** Estimate crawl time from selected sites × categories × page depth. */
export function estimateScrapeMinutes(
  jobs: number,
  pages: number,
  delayMs = 1000
): { pages: number; label: string } {
  const seconds = Math.max(1, Math.round(pages * (2.5 + delayMs / 1000)));
  const minutes = Math.round(seconds / 60);
  return { pages, label: minutes >= 1 ? `~${minutes} min` : `~${seconds} sec` };
}

export function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
