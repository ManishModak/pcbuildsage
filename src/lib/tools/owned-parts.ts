/** Name words that don't identify a part: a user saying "my GPU" doesn't name these. */
const GENERIC_WORDS = new Set([
  "amd", "intel", "nvidia", "geforce", "radeon", "ryzen", "core", "graphics", "card", "gpu", "cpu", "processor",
  "cooler", "stock", "included", "with", "the", "and", "desktop", "memory", "ram", "ssd", "nvme", "power", "supply",
  "case", "cabinet", "motherboard", "board", "edition", "gaming", "series", "black", "white", "owned", "old", "existing"
]);

/**
 * The words of a part name that identify it: tokens with a digit ("3070",
 * "5600x", "650w"), else distinctive words of 4+ letters ("wraith").
 * Empty when the name only says what kind of part it is.
 */
export function identifyingTokens(name: string): string[] {
  const tokens = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const numbered = tokens.filter((t) => /\d/.test(t) && t.length >= 3);
  if (numbered.length > 0) return numbered;
  return tokens.filter((t) => t.length >= 4 && !GENERIC_WORDS.has(t));
}

/** True when the user's words name the part, or the name has nothing to check. */
export function userNamesPart(name: string, userText: string): boolean {
  const tokens = identifyingTokens(name);
  if (tokens.length === 0) return true;
  const haystack = userText.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

/**
 * `category "name"` for each owned part of a build whose identifying words
 * appear in none of the user's messages. Reads the build snapshot's owned
 * components, whose name is the catalog product's when the part came by
 * product_id or key, so an ID-only owned part is checked too. Lightning marked
 * a GPU owned for a user who has none (r11 hinglish) and a 5600G owned to fit
 * a budget (r28 office); LFM3 an RTX 3070 nobody mentioned (r13 esports).
 */
export function unnamedOwnedParts(
  components: ReadonlyArray<{ category: string; name: string; owned?: boolean }>,
  userText: string
): string[] {
  return components.filter((c) => c.owned === true && !userNamesPart(c.name, userText)).map((c) => `${c.category} "${c.name}"`);
}

/** Tells the model why a build with owned parts the user never named can't be presented. */
export function unnamedOwnedNote(parts: readonly string[]): string {
  return `The user hasn't said they own ${parts.join(", ")}, so this build can't be presented: an owned part costs 0 and would misstate the price. Pick it from search_products instead (or leave it out when the build doesn't need it) and validate again.`;
}
