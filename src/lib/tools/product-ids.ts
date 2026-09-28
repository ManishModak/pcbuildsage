/** Short product-ID helpers: 40-char catalog hashes are shown as 10 chars. */

export const SHORT_ID_LEN = 10;
export const MIN_PREFIX_LEN = 8;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LEN);
}

function isPrefixMatch(wanted: string, full: string): boolean {
  return full.toLowerCase().startsWith(wanted.toLowerCase());
}

/**
 * Shortest prefix of `id` (at least MIN_PREFIX_LEN chars) that none of
 * `others` shares, so an ambiguity error can name each candidate by an ID the
 * model can pass back. Candidates sharing their first 10 chars would otherwise
 * all print as the same short ID.
 */
export function distinguishingPrefix(id: string, others: string[]): string {
  let len = MIN_PREFIX_LEN;
  const lower = id.toLowerCase();
  for (const other of others) {
    const o = other.toLowerCase();
    if (o === lower) continue;
    let common = 0;
    while (common < lower.length && common < o.length && lower[common] === o[common]) common++;
    len = Math.max(len, common + 1);
  }
  return id.slice(0, Math.min(len, id.length));
}

export type PrefixResolution =
  | { full: string }
  | { error: string; ambiguous?: string[] };

/**
 * Resolve a user-supplied ID (full or unique prefix >=8 chars) against
 * known full IDs. Exact matches win; otherwise a single prefix match wins.
 */
export function resolveIdPrefix(prefix: string, candidates: string[]): PrefixResolution {
  const p = prefix.trim();
  if (!p) return { error: "Empty product ID. Pass at least 8 chars from search_products." };
  const exact = candidates.find((c) => c === p);
  if (exact) return { full: exact };
  if (p.length < MIN_PREFIX_LEN) {
    return {
      error: `Product ID '${p}' is too short (min ${MIN_PREFIX_LEN} chars). Pass at least ${MIN_PREFIX_LEN} chars from search_products.`
    };
  }
  const matches = candidates.filter((c) => isPrefixMatch(p, c));
  if (matches.length === 0) {
    return {
      error: `Unresolved product ID '${p}'. Verify the ID from search_products results.`
    };
  }
  if (matches.length > 1) {
    return {
      ambiguous: matches,
      error: `Ambiguous product ID prefix '${p}' matches ${matches.length} products: ${matches.map((m) => distinguishingPrefix(m, matches)).join(", ")}. Pass one of these.`
    };
  }
  return { full: matches[0] };
}

/** True when a presented ID refers to the same catalog row as a snapshot ID. */
export function idsMatch(presented: string, snapshotId: string): boolean {
  const p = presented.trim();
  if (!p) return false;
  if (p === snapshotId) return true;
  if (p.length >= MIN_PREFIX_LEN && isPrefixMatch(p, snapshotId)) return true;
  return false;
}
