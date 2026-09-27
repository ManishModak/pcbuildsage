import type { BuildIssue, ProductRow, ValidationResult } from "@/types/client";
import type { BuildSnapshot, BuildSnapshotComponent } from "@/lib/catalog/build-snapshot";
import { sumPricesByCurrency } from "@/lib/format";
import { isTextPart, isToolPart } from "@/lib/message-parts";
import type { ToolPart } from "./tool-chip";
export type { ChatUIMessage } from "./message";
import {
  validationStrip,
  computeValidationStats,
  ruleLabel,
  type StripBadge
} from "./validation-strip";
import {
  buildHeaderSignature,
  buildsFingerprint,
  findAllBuildVersions,
  followNewestVersion,
  openedBuildsForSession,
  resolveSelectedVersion,
  type BuildVersion
} from "./build-versions";

export {
  validationStrip,
  computeValidationStats,
  ruleLabel,
  type StripBadge
};
export {
  buildHeaderSignature,
  buildsFingerprint,
  findAllBuildVersions,
  followNewestVersion,
  openedBuildsForSession,
  resolveSelectedVersion,
  type BuildVersion
};

export const CATEGORY_LABELS: Record<string, string> = {
  cpu: "CPU",
  gpu: "GPU",
  motherboard: "Motherboard",
  ram: "Memory",
  storage: "Storage",
  psu: "Power Supply",
  case: "Case",
  cooler: "Cooler"
};

const CATEGORY_ORDER = ["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"];

export type BuildComponent = {
  category: string;
  categoryLabel: string;
  name: string;
  registryKey?: string;
  productId?: string;
  price: number | null;
  currency: string;
  retailer?: string;
  url?: string;
  unverified: boolean;
  unverifiedNote?: string;
  failed?: boolean;
  failedNote?: string;
  advisory?: boolean;
  advisoryNote?: string;
  status?: "ok" | "failed" | "unverified" | "advisory";
  notInCatalog?: boolean;
};

export type DerivedBuild = {
  /** Model-supplied name for the tradeoff this build makes, when it proposed several. */
  label?: string;
  components: BuildComponent[];
  currency: string;
  validation: ValidationResult | null;
  /**
   * Authoritative total when one exists (from the validate_build snapshot,
   * which is already null when any part is unpriced). `undefined` means "no
   * snapshot", and the total is then summed from the components.
   */
  total?: number | null;
  isLegacy?: boolean;
  /**
   * Set when the turn said a build existed but nothing renderable came with
   * it (no validation, no snapshot, only raw product ids). The card shows an
   * explicit "ask again" message instead of a blank or invented total.
   */
  detailsUnavailable?: boolean;
  /**
   * Set when the build was parsed out of the assistant's prose rather than
   * computed by validate_build. The weakest evidence there is, so the card
   * says so instead of presenting it as a validated proposal.
   */
  textDerived?: boolean;
};

type PartIdentity = { product_id?: string; key?: string; name: string };

/**
 * The total to display for a build.
 *
 * A validate_build snapshot is authoritative and already reports `total: null`
 * when any part is unpriced, so prefer it. Without a snapshot the components
 * are summed, which yields null (rendered as an em dash) when a price is
 * missing or the parts span more than one currency.
 */
export function resolveBuildTotal(build: Pick<DerivedBuild, "total" | "components">): number | null {
  if (build.total !== undefined) return build.total;
  return sumPricesByCurrency(build.components);
}

function partLabel(part: unknown): PartIdentity {
  if (typeof part === "string") return { key: part, name: part };
  if (part && typeof part === "object") {
    const value = part as { product_id?: string; key?: string; name?: string };
    return { product_id: value.product_id, key: value.key, name: value.name ?? value.key ?? "unknown" };
  }
  return { name: "unknown" };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function canonicalizePartName(str: string): string {
  return normalize(str)
    .replace(/^(?:amd|intel|nvidia)\s+/, "")
    .replace(/^(?:geforce)\s+/, "")
    .trim();
}

export function findComponentIssue(
  issues: BuildIssue[],
  category: string,
  key?: string,
  name?: string
): BuildIssue | undefined {
  // Old or malformed saved data can arrive with no issue list at all, or with
  // issues whose `components` is missing or is not an array.
  if (!Array.isArray(issues)) return undefined;
  const normCat = normalize(category);
  const normKey = key ? normalize(key) : undefined;
  const canonKey = key ? canonicalizePartName(key) : undefined;
  const normName = name ? normalize(name) : undefined;
  const canonName = name ? canonicalizePartName(name) : undefined;

  const matching = issues.filter((issue) =>
    (Array.isArray(issue?.components) ? issue.components : []).some((component) => {
      if (typeof component !== "string") return false;
      const c = component.trim();
      if (!c) return false;
      const cNorm = normalize(c);
      const cCanon = canonicalizePartName(c);

      if (c === category || cNorm === normCat) return true;
      if (normKey && (cNorm === normKey || cCanon === canonKey)) return true;
      if (normName && (cNorm === normName || cCanon === canonName)) return true;
      if (normKey && (cNorm.includes(normKey) || normKey.includes(cNorm))) return true;
      if (normName && (cNorm.includes(normName) || normName.includes(cNorm))) return true;
      return false;
    })
  );

  if (matching.length === 0) return undefined;
  const blocking = matching.find((i) => i.severity === "blocking");
  if (blocking) return blocking;
  const unverified = matching.find((i) => i.severity === "needs_research" || i.severity === "needs_verification");
  if (unverified) return unverified;
  return matching[0];
}

export function decorateComponentStatus(
  issue: BuildIssue | undefined,
  hasValidation: boolean
): {
  unverified: boolean;
  unverifiedNote?: string;
  failed?: boolean;
  failedNote?: string;
  advisory?: boolean;
  advisoryNote?: string;
  status: "ok" | "failed" | "unverified" | "advisory";
} {
  if (!hasValidation) {
    return {
      unverified: true,
      unverifiedNote: "Unverified compatibility",
      status: "unverified"
    };
  }

  if (!issue) {
    return {
      unverified: false,
      status: "ok"
    };
  }

  if (issue.severity === "blocking") {
    return {
      unverified: false,
      failed: true,
      failedNote: issue.detail || "Compatibility conflict",
      status: "failed"
    };
  }

  if (issue.severity === "needs_research" || issue.severity === "needs_verification") {
    return {
      unverified: true,
      unverifiedNote:
        issue.detail ||
        (issue.severity === "needs_research"
          ? "Advisory specs (unverified clearances)"
          : "Researched specs (advisory)"),
      status: "unverified"
    };
  }

  if (issue.severity === "advisory") {
    return {
      unverified: false,
      advisory: true,
      advisoryNote: issue.detail || "Advisory",
      status: "advisory"
    };
  }

  return {
    unverified: false,
    status: "ok"
  };
}

export function componentNote(
  issues: BuildIssue[],
  category: string,
  key?: string,
  name?: string
): string | undefined {
  const issue = findComponentIssue(issues, category, key, name);
  if (!issue) return undefined;
  if (issue.detail) return issue.detail;
  if (issue.severity === "needs_research") return "Advisory specs (unverified clearances)";
  if (issue.severity === "needs_verification") return "Researched specs (advisory)";
  return "Advisory";
}

/**
 * Best-effort reconstruction of a proposed build from a message's tool activity:
 * validate_build supplies the parts + compatibility verdict, search_products
 * supplies price / retailer / link for each part where a match is found.
 */
export function deriveBuild(parts: ToolPart[], fallbackCurrency: string): DerivedBuild | null {
  const validatePart = [...parts]
    .reverse()
    .find((part) => part.type === "tool-validate_build" && part.state === "output-available");
  if (!validatePart) return null;

  const input = validatePart.input as { parts?: Record<string, unknown>; label?: string } | undefined;
  if (!input?.parts) return null;
  const validation = (validatePart.output as ValidationResult | undefined) ?? null;
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;

  // Index every product row seen in this message for price/retailer lookup.
  const products: ProductRow[] = [];
  for (const part of parts) {
    if (part.type === "tool-search_products" && part.state === "output-available") {
      const output = part.output as { results?: ProductRow[] } | undefined;
      if (Array.isArray(output?.results)) products.push(...output!.results);
    }
  }
  const byKey = new Map<string, ProductRow>();
  const byName = products.map((product) => ({ product, norm: normalize(product.name) }));
  for (const product of products) {
    if (product.registry_key) byKey.set(product.registry_key, product);
  }

  const findProduct = (label: { key?: string; name: string }): ProductRow | undefined => {
    if (label.key && byKey.has(label.key)) return byKey.get(label.key);
    const target = normalize(label.name);
    const directMatch = byName.find(({ norm }) => norm.includes(target) || target.includes(norm))?.product;
    if (directMatch) return directMatch;

    // Token-overlap matching for variations (e.g., "80+ Gold" vs "80 Plus Gold Full Modular")
    const targetTokens = target.split(" ").filter((t) => t.length > 1);
    if (targetTokens.length >= 2) {
      let bestMatch: ProductRow | undefined;
      let maxScore = 0;
      for (const { product, norm } of byName) {
        const normTokens = new Set(norm.split(" "));
        const matchCount = targetTokens.filter((t) => normTokens.has(t)).length;
        const score = matchCount / targetTokens.length;
        if (score >= 0.5 && matchCount > maxScore) {
          maxScore = matchCount;
          bestMatch = product;
        }
      }
      if (bestMatch) return bestMatch;
    }
    return undefined;
  };

  const currency = products[0]?.currency ?? fallbackCurrency;

  const entries = Object.entries(input.parts).flatMap(([category, raw]) => {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => ({ category, label: partLabel(item) }));
  });

  const components: BuildComponent[] = entries.map(({ category, label }) => {
    const product = findProduct(label);
    const issue = validation
      ? findComponentIssue(validation.issues ?? [], category, label.key ?? label.name, label.name)
      : undefined;
    const statusInfo = decorateComponentStatus(issue, Boolean(validation));

    return {
      category,
      categoryLabel: CATEGORY_LABELS[category] ?? category,
      name: product?.name ?? label.name,
      registryKey: label.key,
      price: product?.price ?? null,
      currency: product?.currency ?? currency,
      retailer: product?.retailer,
      url: product?.url,
      ...statusInfo
    };
  });

  components.sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  );

  return { label, components, currency, validation, isLegacy: true };
}

/**
 * Normalize raw category string to standard category key.
 */
export function normalizeCategory(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[*_`#:]/g, "")
    .trim();

  if (cleaned in CATEGORY_LABELS) return cleaned;
  if (cleaned === "memory" || cleaned === "system memory") return "ram";
  if (cleaned === "processor" || cleaned === "central processing unit") return "cpu";
  if (cleaned === "graphics card" || cleaned === "graphics" || cleaned === "video card" || cleaned === "vga") return "gpu";
  if (cleaned === "mobo" || cleaned === "mainboard" || cleaned === "mother board" || cleaned === "system board") return "motherboard";
  if (cleaned === "power supply" || cleaned === "power supply unit" || cleaned === "power") return "psu";
  if (cleaned === "cabinet" || cleaned === "chassis" || cleaned === "tower" || cleaned === "pc case" || cleaned === "mid tower") return "case";
  if (cleaned === "cpu cooler" || cleaned === "cooling" || cleaned === "aio" || cleaned === "liquid cooler" || cleaned === "air cooler" || cleaned === "heatsink") return "cooler";
  if (cleaned === "ssd" || cleaned === "hdd" || cleaned === "nvme" || cleaned === "hard drive" || cleaned === "solid state drive" || cleaned === "m.2") return "storage";

  if (/\b(?:gpu|graphics|video\s*card|vga)\b/i.test(cleaned)) return "gpu";
  if (/\b(?:cpu|processor|central\s*processing)\b/i.test(cleaned)) return "cpu";
  if (/\b(?:motherboard|mobo|mainboard)\b/i.test(cleaned)) return "motherboard";
  if (/\b(?:ram|memory|ddr[45])\b/i.test(cleaned)) return "ram";
  if (/\b(?:storage|ssd|hdd|nvme|hard\s*drive|m\.2)\b/i.test(cleaned)) return "storage";
  if (/\b(?:psu|power\s*supply)\b/i.test(cleaned)) return "psu";
  if (/\b(?:case|cabinet|chassis|tower)\b/i.test(cleaned)) return "case";
  if (/\b(?:cooler|cooling|aio|heatsink)\b/i.test(cleaned)) return "cooler";

  return null;
}

export function parsePriceAndCurrency(
  raw: string,
  fallbackCurrency: string
): { price: number | null; currency: string } {
  if (!raw) return { price: null, currency: fallbackCurrency };
  const cleaned = raw.replace(/[*_`]/g, "").trim();

  let currency = fallbackCurrency;
  if (cleaned.includes("₹") || /rs\.?|inr/i.test(cleaned)) {
    currency = "INR";
  } else if (cleaned.includes("$") || /usd/i.test(cleaned)) {
    currency = "USD";
  } else if (cleaned.includes("€") || /eur/i.test(cleaned)) {
    currency = "EUR";
  } else if (cleaned.includes("£") || /gbp/i.test(cleaned)) {
    currency = "GBP";
  }

  const numPart = cleaned.replace(/[^0-9.,]/g, " ").trim();
  const match = numPart.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b/);
  if (match) {
    const val = parseFloat(match[0].replace(/,/g, ""));
    if (!isNaN(val) && val > 0) {
      return { price: val, currency };
    }
  }

  return { price: null, currency };
}

export function extractLinkAndName(text: string): { name: string; url?: string } {
  const linkMatch = text.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
  if (linkMatch) {
    const url = linkMatch[2];
    const name = text.replace(linkMatch[0], linkMatch[1]).replace(/[*_`]/g, "").trim();
    return { name, url };
  }
  return { name: text.replace(/[*_`]/g, "").trim() };
}

export function parseTableToBuild(
  tableLines: string[],
  fallbackCurrency: string,
  label?: string
): DerivedBuild | null {
  if (tableLines.length < 2) return null;
  if (label && /tradeoff|comparison|difference|factor|metric|vs\b/i.test(label)) return null;

  const parseRow = (line: string): string[] => {
    let trimmed = line.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map((cell) => cell.trim());
  };

  const rows = tableLines.map(parseRow);
  if (rows.length < 2) return null;

  const header = rows[0];
  if (header.some((cell) => /tradeoff|comparison|difference|factor|metric/i.test(cell))) return null;

  let categoryCol = -1;
  let nameCol = -1;
  let priceCol = -1;
  let retailerCol = -1;
  let urlCol = -1;

  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase().replace(/[*_`:]/g, "").trim();
    if (/^(?:component|category|part type|item type|slot)$/i.test(h) || (/component|category|slot/i.test(h) && categoryCol === -1)) {
      categoryCol = i;
    } else if (
      /^(?:part|product|model|name|item|specification|description|selected part)$/i.test(h) ||
      (/part|product|model|name|item|spec/i.test(h) && nameCol === -1)
    ) {
      nameCol = i;
    } else if (
      /^(?:price|cost|inr|usd|amount|est\.?\s*price|approx\.?\s*price)$/i.test(h) ||
      (/price|cost|inr|usd|amount/i.test(h) && priceCol === -1)
    ) {
      priceCol = i;
    } else if (/retailer|store|shop|seller|merchant/i.test(h) && retailerCol === -1) {
      retailerCol = i;
    } else if (/link|url|buy/i.test(h) && urlCol === -1) {
      urlCol = i;
    }
  }

  let startRow = 1;
  // If row 0 is actually data (starts with valid category) and not standard header label
  if (normalizeCategory(header[0]) && !/^(?:component|category|part|item)$/i.test(header[0].trim())) {
    categoryCol = 0;
    nameCol = 1;
    priceCol = header.length > 2 ? 2 : -1;
    startRow = 0;
  } else {
    if (categoryCol === -1 && nameCol === -1 && priceCol === -1) {
      if (header.length >= 3) {
        categoryCol = 0;
        nameCol = 1;
        priceCol = 2;
      } else if (header.length === 2) {
        categoryCol = 0;
        nameCol = 1;
      }
    } else {
      if (categoryCol === -1) categoryCol = 0;
      if (nameCol === -1) nameCol = header.length > 1 ? 1 : 0;
      if (priceCol === -1 && header.length > 2) priceCol = 2;
    }
  }

  const components: BuildComponent[] = [];
  let detectedCurrency = fallbackCurrency;

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || row.every((cell) => /^:?-+:?$/.test(cell.trim()))) {
      continue;
    }

    const rawCategory = row[categoryCol] || "";
    const rawName = row[nameCol] || "";
    const rawPrice = priceCol !== -1 ? row[priceCol] || "" : "";
    const rawRetailer = retailerCol !== -1 ? row[retailerCol] || "" : "";
    const rawUrl = urlCol !== -1 ? row[urlCol] || "" : "";

    if (
      row.some((cell) => /^(?:\*\*)?(?:total|subtotal|estimated total|grand total)(?:\*\*)?$/i.test(cell.trim())) ||
      /total|subtotal/i.test(rawCategory)
    ) {
      continue;
    }

    const category = normalizeCategory(rawCategory);
    if (!category) continue;

    const { name: cleanName, url: linkUrl } = extractLinkAndName(rawName);
    const { name: cleanRetailer, url: retailerUrl } = rawRetailer
      ? extractLinkAndName(rawRetailer)
      : { name: "", url: undefined };
    const { url: explicitUrl } = rawUrl ? extractLinkAndName(rawUrl) : { url: undefined };

    const { price, currency } = parsePriceAndCurrency(rawPrice || rawName, fallbackCurrency);
    if (currency !== fallbackCurrency) {
      detectedCurrency = currency;
    }

    components.push({
      category,
      categoryLabel: CATEGORY_LABELS[category] ?? category.toUpperCase(),
      name: cleanName || rawName,
      price,
      currency,
      retailer: cleanRetailer || undefined,
      url: explicitUrl || linkUrl || retailerUrl || undefined,
      unverified: false
    });
  }

  const pricedCount = components.filter((c) => c.price != null && c.price >= 500).length;
  if (components.length < 2 || pricedCount < 2) return null;

  components.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

  return {
    label,
    components,
    currency: detectedCurrency,
    validation: null,
    isLegacy: true
  };
}

export function parseBulletListToBuild(
  lines: string[],
  fallbackCurrency: string,
  label?: string
): DerivedBuild | null {
  const components: BuildComponent[] = [];
  let detectedCurrency = fallbackCurrency;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$|^\d+\.\s+(.+)$/);
    if (!bulletMatch) continue;

    const content = (bulletMatch[1] || bulletMatch[2]).trim();

    const catMatch =
      content.match(/^(?:\[|\*\*)?([A-Za-z0-9\s/()\-]+?)(?:\]|\*\*)?\s*:\s*(.+)$/) ||
      content.match(/^(?:\*\*)?([A-Za-z0-9\s/()\-]+?)(?:\*\*)?\s*[-–—|]\s*(.+)$/);

    if (!catMatch) continue;

    const rawCategory = catMatch[1].trim();
    const rest = catMatch[2].trim();

    if (/total|subtotal|budget/i.test(rawCategory)) continue;

    const category = normalizeCategory(rawCategory);
    if (!category) continue;

    const { name: linkName, url } = extractLinkAndName(rest);

    let retailer: string | undefined;
    let textWithoutRetailer = linkName;
    const retailerMatch = textWithoutRetailer.match(/\((?:at\s+|from\s+)?([A-Za-z0-9\s.&]+)\)\s*$/);
    if (retailerMatch && !/^\s*[₹$€£\d]/.test(retailerMatch[1])) {
      retailer = retailerMatch[1].trim();
      textWithoutRetailer = textWithoutRetailer.replace(retailerMatch[0], "").trim();
    }

    let partName = textWithoutRetailer;
    let price: number | null = null;
    let currency = fallbackCurrency;

    const splitMatch = textWithoutRetailer.match(
      /^(.*?)\s*(?:—|–| - | \| | @ |:\s*₹|:\s*\$)\s*([₹$€£\d,.\sA-Za-z]+)$/
    );
    if (splitMatch) {
      partName = splitMatch[1].trim();
      const priceStr = splitMatch[2].trim();
      const parsed = parsePriceAndCurrency(priceStr, fallbackCurrency);
      price = parsed.price;
      currency = parsed.currency;
    } else {
      const parsed = parsePriceAndCurrency(textWithoutRetailer, fallbackCurrency);
      if (parsed.price !== null) {
        price = parsed.price;
        currency = parsed.currency;
        partName = textWithoutRetailer
          .replace(/[₹$€£]\s*[\d,]+(?:\.\d{2})?/g, "")
          .replace(/Rs\.?\s*[\d,]+/gi, "")
          .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s*(?:INR|USD|EUR|GBP)?/g, "")
          .replace(/[—–\-|,()]/g, " ")
          .trim();
      }
    }

    if (currency !== fallbackCurrency) {
      detectedCurrency = currency;
    }

    partName = partName.replace(/^[:\-–—|]\s*/, "").replace(/[:\-–—|]\s*$/, "").trim();

    components.push({
      category,
      categoryLabel: CATEGORY_LABELS[category] ?? category.toUpperCase(),
      name: partName || rest,
      price,
      currency,
      retailer,
      url,
      unverified: false
    });
  }

  const pricedCount = components.filter((c) => c.price != null && c.price >= 500).length;
  if (components.length < 2 || pricedCount < 2) return null;

  components.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

  return {
    label,
    components,
    currency: detectedCurrency,
    validation: null,
    isLegacy: true
  };
}

export function parseBuildsFromMarkdown(markdown: string, fallbackCurrency: string): DerivedBuild[] {
  if (!markdown || typeof markdown !== "string") return [];

  const lines = markdown.split("\n");
  type Section = { label?: string; lines: string[] };
  const sections: Section[] = [];
  let currentSection: Section = { lines: [] };

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,4}\s+(.+)$/);
    const boldHeaderMatch = line.match(/^\*\*(?:Build|Option|Tier|Variant)\s*(\d+|[A-Z])?[:\s\-–—](.*?)\*\*/i);

    if (headerMatch) {
      if (currentSection.lines.length > 0) {
        sections.push(currentSection);
      }
      currentSection = {
        label: headerMatch[1].replace(/[*_`]/g, "").trim(),
        lines: []
      };
    } else if (boldHeaderMatch) {
      if (currentSection.lines.length > 0) {
        sections.push(currentSection);
      }
      currentSection = {
        label: line.replace(/[*_`]/g, "").trim(),
        lines: []
      };
    } else {
      currentSection.lines.push(line);
    }
  }
  if (currentSection.lines.length > 0) {
    sections.push(currentSection);
  }

  const results: DerivedBuild[] = [];

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    const sLines = section.lines;

    const tableBlocks: string[][] = [];
    let currentTable: string[] = [];

    for (const line of sLines) {
      if (line.trim().startsWith("|") || (line.includes("|") && line.trim().endsWith("|"))) {
        currentTable.push(line);
      } else {
        if (currentTable.length >= 2) {
          tableBlocks.push(currentTable);
        }
        currentTable = [];
      }
    }
    if (currentTable.length >= 2) {
      tableBlocks.push(currentTable);
    }

    if (tableBlocks.length > 0) {
      for (let t = 0; t < tableBlocks.length; t++) {
        const tableLabel =
          section.label || (tableBlocks.length > 1 ? `Build ${results.length + 1}` : undefined);
        const build = parseTableToBuild(tableBlocks[t], fallbackCurrency, tableLabel);
        if (build) {
          results.push(build);
        }
      }
      continue;
    }

    const bulletLines = sLines.filter((line) => /^[\s\t]*(?:[-*+]|\d+\.)\s+/.test(line));
    if (bulletLines.length >= 2) {
      const build = parseBulletListToBuild(bulletLines, fallbackCurrency, section.label);
      if (build) {
        results.push(build);
      }
    }
  }

  if (results.length === 0) {
    const allTableLines = lines.filter(
      (line) => line.trim().startsWith("|") || (line.includes("|") && line.trim().endsWith("|"))
    );
    if (allTableLines.length >= 2) {
      const build = parseTableToBuild(allTableLines, fallbackCurrency);
      if (build) results.push(build);
    }

    if (results.length === 0) {
      const allBulletLines = lines.filter((line) => /^[\s\t]*(?:[-*+]|\d+\.)\s+/.test(line));
      if (allBulletLines.length >= 2) {
        const build = parseBulletListToBuild(allBulletLines, fallbackCurrency);
        if (build) results.push(build);
      }
    }
  }

  if (results.length === 1 && !results[0].label) {
    results[0].label = "Proposed Build";
  }

  return results;
}

function isComponentMatch(vPart: PartIdentity, bPart: PartIdentity): boolean {
  if (vPart.product_id || bPart.product_id) return Boolean(vPart.product_id && vPart.product_id === bPart.product_id);
  const bPartName = bPart.name;
  const normB = normalize(bPartName);
  const canonB = canonicalizePartName(bPartName);

  if (vPart.key) {
    const normKey = normalize(vPart.key);
    if (normB === normKey || canonB === canonicalizePartName(vPart.key)) {
      return true;
    }
  }

  const normV = normalize(vPart.name);
  if (normB === normV || canonB === canonicalizePartName(vPart.name)) {
    return true;
  }

  return false;
}

/** A saved snapshot is usable when it still carries the component list. */
export function isBuildSnapshot(value: unknown): value is BuildSnapshot {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as BuildSnapshot).components);
}

/** The AI SDK lets a tool part name its tool by `type` or by `toolName`. */
export function isValidatePart(part: ToolPart): boolean {
  return part.type === "tool-validate_build" || part.toolName === "validate_build";
}

/** Is this part a `present_build` call at all? */
export function isPresentBuildPart(part: ToolPart): boolean {
  return part.type === "tool-present_build" || part.toolName === "present_build";
}

/**
 * A `present_build` is a build only once the model finished it. Treating "has
 * any input" as finished is what left interrupted sessions with a build panel
 * that rendered nothing at all: the tool chip kept spinning forever, the call
 * was replayed on reload, and the card was rebuilt from a half-written input.
 * `input-available` / `input-streaming` still count while the part belongs to
 * the message currently being streamed.
 */
export function isFinishedPresentPart(
  part: ToolPart,
  messageId?: string,
  streamingMessageId?: string
): boolean {
  if (!isPresentBuildPart(part)) return false;
  if (part.state === "output-available") return true;
  if (part.state === "input-available" || part.state === "input-streaming") {
    return Boolean(messageId) && messageId === streamingMessageId;
  }
  return false;
}

/** True when a validate_build output carries at least one build snapshot. */
export function hasValidationSnapshot(part: ToolPart): boolean {
  const output = part.output;
  if (!output || typeof output !== "object") return false;
  const out = output as { builds?: unknown; snapshot?: unknown };
  if (isBuildSnapshot(out.snapshot)) return true;
  if (out.builds && typeof out.builds === "object") {
    return Object.values(out.builds as Record<string, unknown>).some((entry) =>
      Boolean(entry) && typeof entry === "object" && isBuildSnapshot((entry as { snapshot?: unknown }).snapshot)
    );
  }
  return false;
}

/**
 * A snapshot component falls back to the raw product id the model passed in
 * when the catalog has no listing for it (`createBuildSnapshot` does exactly
 * that). That id is not a product name and must never reach the name slot.
 */
function isOpaqueProductId(name: string, productId?: string): boolean {
  if (!name) return true;
  if (productId && name === productId) return true;
  if (/\s/.test(name)) return false;
  return /^[0-9a-f]{16,}$/i.test(name) || /^[0-9a-z]{20,}$/i.test(name);
}

/** What a build parsed out of the assistant's prose is labelled, exactly. */
export const TEXT_BUILD_CAVEAT = "Not validated — from the assistant's text";

/**
 * The blocking issues the latest finished validate_build in this turn raised.
 * A text-parsed build is still shown next to them: a build the rules engine
 * rejected must not look clean just because it was never validated.
 */
function blockingIssuesFromToolParts(toolParts: ToolPart[]): BuildIssue[] {
  for (let i = toolParts.length - 1; i >= 0; i--) {
    const part = toolParts[i];
    if (!isValidatePart(part) || part.state !== "output-available") continue;
    const output = part.output as { issues?: unknown; builds?: unknown } | undefined;
    if (!output || typeof output !== "object") continue;

    const candidates: unknown[] = [];
    if (output.builds && typeof output.builds === "object") {
      for (const entry of Object.values(output.builds as Record<string, unknown>)) {
        const issues = (entry as { issues?: unknown } | undefined)?.issues;
        if (Array.isArray(issues)) candidates.push(...issues);
      }
    } else if (Array.isArray(output.issues)) {
      candidates.push(...output.issues);
    }

    const blocking = candidates.filter(
      (issue): issue is BuildIssue =>
        Boolean(issue) &&
        typeof issue === "object" &&
        (issue as BuildIssue).severity === "blocking"
    );
    if (blocking.length > 0) return blocking;
  }
  return [];
}

/**
 * Mark builds that came from the assistant's text rather than from
 * validate_build, and surface any blocking issue raised in the same turn.
 *
 * Components with no issue stay unverified rather than becoming "ok": a text
 * build was never checked, and the caveat label is what says so.
 */
export function markTextDerivedBuilds(builds: DerivedBuild[], toolParts: ToolPart[]): DerivedBuild[] {
  const blocking = blockingIssuesFromToolParts(toolParts);
  return builds.map((build) => {
    // A component the rules engine named keeps its verdict; every other one
    // stays unverified, because nothing ever checked it.
    const components = build.components.map((component) => {
      const issue =
        blocking.length > 0
          ? findComponentIssue(
              blocking,
              component.category,
              component.registryKey ?? component.productId,
              component.name
            )
          : undefined;
      return {
        ...component,
        ...(issue ? decorateComponentStatus(issue, true) : decorateComponentStatus(undefined, false))
      };
    });

    return {
      ...build,
      components,
      textDerived: true,
      // The summary is load-bearing: without it computeValidationStats falls
      // back to counting the rules a build was never run against, and the card
      // would report "1 check failed - 6 passed" for a build nothing checked.
      validation:
        blocking.length > 0
          ? {
              valid: false,
              issues: blocking,
              resolved: {},
              summary: {
                passed: 0,
                failed: blocking.length,
                unverified: 0,
                text: `${blocking.length} check(s) failed`
              }
            }
          : null
    };
  });
}

/**
 * Render a build straight from a `validate_build` snapshot. Snapshots are the
 * catalog-calculated data the rules engine produced, so this is what a turn
 * can still show when it validated a build but was interrupted before it got
 * to present one.
 */
export function derivedBuildFromSnapshot(
  snapshot: BuildSnapshot,
  validation: ValidationResult | null,
  fallbackCurrency = "USD"
): DerivedBuild {
  const currency =
    typeof snapshot.currency === "string" && snapshot.currency ? snapshot.currency : fallbackCurrency;
  const rawComponents = Array.isArray(snapshot.components) ? snapshot.components : [];

  const components: BuildComponent[] = rawComponents
    .map((raw): BuildComponent => {
      const snapComp = (raw ?? {}) as BuildSnapshotComponent;
      const category = typeof snapComp.category === "string" ? snapComp.category : "other";
      const categoryLabel = CATEGORY_LABELS[category] ?? category;
      const productId =
        typeof snapComp.product_id === "string" && snapComp.product_id.trim() ? snapComp.product_id.trim() : undefined;
      const rawName = typeof snapComp.name === "string" ? snapComp.name.trim() : "";
      const price = typeof snapComp.price === "number" && !Number.isNaN(snapComp.price) ? snapComp.price : null;
      const componentCurrency =
        typeof snapComp.currency === "string" && snapComp.currency ? snapComp.currency : currency;
      const issue = validation
        ? findComponentIssue(validation.issues ?? [], category, productId, rawName)
        : undefined;
      const statusInfo = decorateComponentStatus(issue, Boolean(validation));

      return {
        category,
        categoryLabel,
        // An unresolved part is named by its category, never by its product id.
        name: isOpaqueProductId(rawName, productId) ? categoryLabel : rawName,
        registryKey: undefined,
        productId,
        price,
        currency: componentCurrency,
        retailer: typeof snapComp.retailer === "string" ? snapComp.retailer : undefined,
        url: typeof snapComp.url === "string" ? snapComp.url : undefined,
        notInCatalog: price === null,
        ...statusInfo
      };
    })
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

  return {
    label: typeof snapshot.label === "string" && snapshot.label.trim() ? snapshot.label.trim() : undefined,
    components,
    currency,
    validation,
    // The snapshot total is null unless every part is priced in its own
    // currency — better an honest "—" than a sum that is quietly too low.
    total: typeof snapshot.total === "number" ? snapshot.total : null,
    isLegacy: false
  };
}

/**
 * Every build a finished `validate_build` call produced, taken from its
 * snapshots. Used for turns that never reached `present_build`.
 */
export function derivedBuildsFromValidation(part: ToolPart, fallbackCurrency: string): DerivedBuild[] {
  const output = part.output;
  if (!output || typeof output !== "object") return [];
  const out = output as { builds?: unknown; snapshot?: unknown };

  const builds: DerivedBuild[] = [];

  if (out.builds && typeof out.builds === "object") {
    for (const entry of Object.values(out.builds as Record<string, ValidationResult>)) {
      const snapshot = (entry as { snapshot?: unknown } | undefined)?.snapshot;
      if (isBuildSnapshot(snapshot)) builds.push(derivedBuildFromSnapshot(snapshot, entry, fallbackCurrency));
    }
  }

  if (builds.length === 0 && isBuildSnapshot(out.snapshot)) {
    builds.push(derivedBuildFromSnapshot(out.snapshot, output as ValidationResult, fallbackCurrency));
  }

  return builds;
}

export type MatchedValidation = {
  validation: ValidationResult;
  snapshot?: BuildSnapshot;
};

/**
 * The issues that mention a component, narrowed by product id when the build
 * names one. `issue.components` is read defensively: saved sessions from older
 * builds can carry issues without it.
 */
function issuesForComponent(
  issues: BuildIssue[] | undefined,
  productId: string | undefined,
  category: string
): BuildIssue[] {
  if (!Array.isArray(issues) || issues.length === 0) return [];
  if (!productId) return issues;
  return issues.filter((issue) => {
    const components = Array.isArray(issue?.components) ? issue.components : [];
    return components.includes(productId) || components.includes(category);
  });
}

type PresentedBuild = {
  label?: string;
  parts?: Array<{ category: string; name: string; product_id?: string }>;
  product_ids?: string[];
};

/**
 * The validate_build output a presented build refers to, judged by label. The
 * caller verifies the parts before accepting it: labels get reused across
 * turns, so a label match alone is not evidence that it is the same build.
 */
function matchValidationByLabel(build: PresentedBuild, vPart: ToolPart): MatchedValidation | null {
  const output = vPart.output;
  if (!output || typeof output !== "object") return null;
  const out = output as Record<string, unknown>;

  // 1. Multi-build output: out.builds is an object keyed by label
  if (out.builds && typeof out.builds === "object") {
    const buildsObj = out.builds as Record<string, ValidationResult & { snapshot?: BuildSnapshot }>;
    if (build.label && buildsObj[build.label]) {
      return { validation: buildsObj[build.label], snapshot: buildsObj[build.label].snapshot };
    }
    if (build.label) {
      const matchKey = Object.keys(buildsObj).find(
        (k) => k.trim().toLowerCase() === build.label!.trim().toLowerCase()
      );
      if (matchKey && buildsObj[matchKey]) {
        return { validation: buildsObj[matchKey], snapshot: buildsObj[matchKey].snapshot };
      }
    }
    // If 1 build exists in output and label was omitted
    const entries = Object.entries(buildsObj);
    if (!build.label && entries.length === 1 && !Array.isArray(build.parts)) {
      return { validation: entries[0][1], snapshot: entries[0][1].snapshot };
    }
  }

  // 2. Output itself is keyed by label: out[build.label]
  if (
    build.label &&
    out[build.label] &&
    typeof out[build.label] === "object" &&
    "valid" in (out[build.label] as object)
  ) {
    const val = out[build.label] as ValidationResult & { snapshot?: BuildSnapshot };
    return { validation: val, snapshot: val.snapshot };
  }

  // 3. Single-build output (legacy): output has `valid` directly at top level
  if ("valid" in out) {
    const vInput = vPart.input as { label?: string; parts?: Record<string, unknown> } | undefined;
    const vValidation = out as unknown as ValidationResult & { snapshot?: BuildSnapshot };

    if (build.label && vInput?.label) {
      if (vInput.label.trim().toLowerCase() === build.label.trim().toLowerCase()) {
        return { validation: vValidation, snapshot: vValidation.snapshot };
      }
    } else if (!build.label && !vInput?.label && !Array.isArray(build.parts)) {
      return { validation: vValidation, snapshot: vValidation.snapshot };
    }
  }

  return null;
}

/** Every catalog product id a validate_build call was given, in its input. */
function productIdsOfValidationInput(vPart: ToolPart): string[] {
  const input = vPart.input as
    | { parts?: Record<string, unknown>; builds?: Array<{ parts?: unknown }> }
    | undefined;
  if (!input || typeof input !== "object") return [];

  const ids: string[] = [];
  const collect = (raw: unknown) => {
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const id = partLabel(entry).product_id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  };

  if (input.parts && typeof input.parts === "object") {
    for (const raw of Object.values(input.parts)) collect(raw);
  }
  if (Array.isArray(input.builds)) {
    for (const entry of input.builds) {
      if (entry?.parts && typeof entry.parts === "object" && !Array.isArray(entry.parts)) {
        for (const raw of Object.values(entry.parts)) collect(raw);
      }
    }
  }
  return ids;
}

function snapshotProductIds(snapshot?: BuildSnapshot): string[] {
  if (!snapshot || !Array.isArray(snapshot.components)) return [];
  return snapshot.components
    .map((component) => component?.product_id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

/** Catalog product ids a presented build refers to, however it spelled them. */
function presentedProductIds(build: PresentedBuild): string[] {
  const ids = Array.isArray(build.product_ids) ? [...build.product_ids] : [];
  const fromParts = Array.isArray(build.parts) ? build.parts : [];
  for (const part of fromParts) {
    if (typeof part?.product_id === "string" && part.product_id.trim()) ids.push(part.product_id.trim());
  }
  return ids.filter((id) => typeof id === "string" && id.length > 0);
}

/** Do the two sets cover the same parts, category by category? */
function componentSetsMatch(
  buildParts: Array<{ category: string; name: string; product_id?: string }>,
  inputParts: Record<string, unknown>
): boolean {
  const bMap = new Map<string, PartIdentity[]>();
  for (const p of buildParts) {
    // Old or malformed saved data can carry a null part or a null category;
    // never call string methods on whatever came out of storage.
    if (!p || typeof p !== "object") continue;
    const rawCategory = String(p.category ?? "");
    const normCat = normalizeCategory(rawCategory) ?? rawCategory.toLowerCase();
    const list = bMap.get(normCat) ?? [];
    list.push(p as PartIdentity);
    bMap.set(normCat, list);
  }

  const vMap = new Map<string, PartIdentity[]>();
  for (const [rawCategory, raw] of Object.entries(inputParts)) {
    const normCat = normalizeCategory(String(rawCategory ?? "")) ?? String(rawCategory ?? "").toLowerCase();
    const items = Array.isArray(raw) ? raw : [raw];
    vMap.set(normCat, items.map(partLabel));
  }

  if (bMap.size !== vMap.size) return false;
  for (const [cat, bList] of bMap.entries()) {
    const vList = vMap.get(cat);
    if (!vList || vList.length !== bList.length) return false;
    const matchedIndices = new Set<number>();
    for (const bName of bList) {
      let foundMatch = false;
      for (let vi = 0; vi < vList.length; vi++) {
        if (!matchedIndices.has(vi) && isComponentMatch(vList[vi], bName)) {
          matchedIndices.add(vi);
          foundMatch = true;
          break;
        }
      }
      if (!foundMatch) return false;
    }
  }
  return true;
}

/**
 * Confirm a label match really describes this build before trusting it.
 *
 * Returns true when there is nothing to compare against, so a bare label is
 * still enough for shapes that carry no parts to check.
 */
function candidateDescribesBuild(build: PresentedBuild, candidate: MatchedValidation, vPart: ToolPart): boolean {
  const wantedIds = presentedProductIds(build);
  if (wantedIds.length > 0) {
    // Product ids are the model's own link to the catalog, so they are the
    // strongest evidence available and they survive a relabelled build.
    const knownIds = snapshotProductIds(candidate.snapshot);
    const source = knownIds.length > 0 ? knownIds : productIdsOfValidationInput(vPart);
    if (source.length > 0) return wantedIds.every((id) => source.includes(id));
    return true;
  }

  if (Array.isArray(build.parts) && build.parts.length > 0) {
    const input = vPart.input as { parts?: Record<string, unknown> } | undefined;
    if (input?.parts && typeof input.parts === "object") {
      return componentSetsMatch(build.parts, input.parts);
    }
  }
  return true;
}

/** Every validation a validate_build output carries, snapshot included. */
function validationCandidates(vPart: ToolPart): MatchedValidation[] {
  const output = vPart.output;
  if (!output || typeof output !== "object") return [];
  const out = output as Record<string, unknown>;
  const candidates: MatchedValidation[] = [];

  if (out.builds && typeof out.builds === "object") {
    for (const entry of Object.values(out.builds as Record<string, ValidationResult>)) {
      if (entry && typeof entry === "object") {
        const validation = entry as ValidationResult & { snapshot?: BuildSnapshot };
        candidates.push({ validation, snapshot: validation.snapshot });
      }
    }
  }
  if ("valid" in out) {
    const validation = output as ValidationResult & { snapshot?: BuildSnapshot };
    candidates.push({ validation, snapshot: validation.snapshot });
  }
  return candidates;
}

/**
 * No label matched, so match on catalog product ids instead: the model
 * routinely renames a build between validating and presenting it, but it keeps
 * passing the same ids.
 */
function matchValidationByProductIds(build: PresentedBuild, validateParts: ToolPart[]): MatchedValidation | null {
  const wantedIds = presentedProductIds(build);
  if (wantedIds.length === 0) return null;

  for (let i = validateParts.length - 1; i >= 0; i--) {
    for (const candidate of validationCandidates(validateParts[i])) {
      const knownIds = snapshotProductIds(candidate.snapshot);
      if (knownIds.length > 0 && wantedIds.every((id) => knownIds.includes(id))) return candidate;
    }
  }
  return null;
}

/**
 * Find the validation a presented build came from.
 *
 * Two passes: first by label, but only accepting a match whose parts (or
 * product ids) agree, so a duplicated label falls through to the validation
 * that really is this build; then by product id for the builds the model
 * relabelled. Returns null when nothing matches, and the card then says the
 * details are unavailable instead of inventing them.
 */
export function findMatchingValidationResult(
  build: PresentedBuild,
  validateParts: ToolPart[]
): MatchedValidation | null {
  if (validateParts.length === 0) return null;

  for (let i = validateParts.length - 1; i >= 0; i--) {
    const vPart = validateParts[i];
    const candidate = matchValidationByLabel(build, vPart);
    if (candidate && candidateDescribesBuild(build, candidate, vPart)) return candidate;
  }

  return matchValidationByProductIds(build, validateParts);
}

export function findMatchingValidation(
  build: { label?: string; parts?: Array<{ category: string; name: string; product_id?: string }>; product_ids?: string[] },
  validateParts: ToolPart[]
): ValidationResult | null {
  return findMatchingValidationResult(build, validateParts)?.validation ?? null;
}

export function deriveBuildsFromToolParts(
  parts: ToolPart[],
  fallbackCurrency: string,
  targetPresentPart?: ToolPart
): DerivedBuild[] {
  // Auto-discovery has no streaming context, so only a finished call counts:
  // a half-written present_build must never become a build (see
  // isFinishedPresentPart for why that used to blank the panel).
  const presentPart =
    targetPresentPart ??
    [...parts].reverse().find((part) => isFinishedPresentPart(part));

  if (presentPart) {
    const input = presentPart.input as
      | {
          builds?: Array<{
            label?: string;
            product_ids?: string[];
            parts?: Array<{
              category: string;
              product_id?: string;
              name: string;
              price?: number | null;
              currency?: string;
              retailer?: string;
              url?: string;
            }>;
            notes?: string;
          }>;
        }
      | undefined;

    if (input?.builds && Array.isArray(input.builds)) {
      const presentIdx = parts.indexOf(presentPart);
      const relevantParts = presentIdx !== -1 ? parts.slice(0, presentIdx + 1) : parts;
      const validateParts = relevantParts.filter(
        (part) =>
          (part.type === "tool-validate_build" || part.toolName === "validate_build") &&
          (part.state === "output-available" || Boolean((part as { output?: unknown }).output))
      );

      return input.builds.map((build) => {
        const isLegacy = Array.isArray(build.parts);
        const matched = findMatchingValidationResult(build, validateParts);
        const matchedValidation = matched?.validation ?? null;
        const matchedSnapshot = matched?.snapshot ?? null;

        if (!isLegacy) {
          // New format: build card uses validated catalog data ONLY.
          const currency = matchedSnapshot?.currency ?? fallbackCurrency;

          let components: BuildComponent[] = [];
          if (matchedSnapshot && Array.isArray(matchedSnapshot.components) && matchedSnapshot.components.length > 0) {
            components = matchedSnapshot.components.map((snapComp) => {
              const hasCatalogId = Boolean(snapComp.product_id && snapComp.product_id.trim());
              const category = String(snapComp.category);
              const categoryLabel = CATEGORY_LABELS[category] ?? category;
              const issue = matchedValidation
                ? findComponentIssue(
                    issuesForComponent(matchedValidation.issues, snapComp.product_id, category),
                    category,
                    snapComp.product_id,
                    snapComp.name
                  )
                : undefined;
              const statusInfo = decorateComponentStatus(issue, Boolean(matchedValidation));

              if (hasCatalogId) {
                return {
                  category,
                  categoryLabel,
                  // A snapshot reuses the raw product id as the name when the
                  // catalog lookup missed; a product id is not a name.
                  name: isOpaqueProductId(snapComp.name, snapComp.product_id) ? categoryLabel : snapComp.name,
                  productId: snapComp.product_id,
                  price: snapComp.price,
                  currency: snapComp.currency || currency,
                  retailer: snapComp.retailer,
                  url: snapComp.url,
                  notInCatalog: false,
                  ...statusInfo
                };
              }

              return {
                category,
                categoryLabel,
                name: isOpaqueProductId(snapComp.name, snapComp.product_id) ? categoryLabel : snapComp.name,
                productId: undefined,
                price: null,
                currency,
                retailer: undefined,
                url: undefined,
                notInCatalog: true,
                ...statusInfo
              };
            });
          }

          components.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

          return {
            label: build.label,
            currency,
            validation: matchedValidation,
            // Authoritative when there is a snapshot: null (an em dash) rather
            // than a subtotal that silently omits unpriced parts.
            total: matchedSnapshot
              ? typeof matchedSnapshot.total === "number"
                ? matchedSnapshot.total
                : null
              : undefined,
            components,
            // No snapshot and nothing but product ids: the build exists, but
            // nothing about it can be rendered honestly.
            detailsUnavailable: components.length === 0,
            isLegacy: false
          };
        }

        // Legacy format:
        const currency = build.parts?.find((p) => p.currency)?.currency ?? matchedSnapshot?.currency ?? fallbackCurrency;

        const snapshotMap = new Map<string, BuildSnapshotComponent>();
        if (Array.isArray(matchedSnapshot?.components)) {
          for (const sc of matchedSnapshot.components) {
            if (sc?.product_id) snapshotMap.set(sc.product_id.trim(), sc);
          }
        }

        const components: BuildComponent[] = (build.parts || [])
          .map((part) => {
            const issue = matchedValidation
              ? findComponentIssue(
                  issuesForComponent(matchedValidation.issues, part.product_id, part.category),
                  part.category,
                  part.product_id,
                  part.name
                )
              : undefined;
            const statusInfo = decorateComponentStatus(issue, Boolean(matchedValidation));

            if (matchedSnapshot) {
              const snapComp = part.product_id ? snapshotMap.get(part.product_id.trim()) : undefined;
              if (snapComp) {
                return {
                  category: part.category,
                  categoryLabel: CATEGORY_LABELS[part.category] ?? part.category,
                  name: snapComp.name,
                  productId: snapComp.product_id,
                  price: snapComp.price,
                  currency: snapComp.currency || currency,
                  retailer: snapComp.retailer,
                  url: snapComp.url,
                  notInCatalog: false,
                  ...statusInfo
                };
              }
              return {
                category: part.category,
                categoryLabel: CATEGORY_LABELS[part.category] ?? part.category,
                name: part.name,
                productId: undefined,
                price: null,
                currency,
                retailer: undefined,
                url: undefined,
                notInCatalog: true,
                ...statusInfo
              };
            }

            return {
              category: part.category,
              categoryLabel: CATEGORY_LABELS[part.category] ?? part.category,
              name: part.name,
              productId: part.product_id,
              price: typeof part.price === "number" ? part.price : null,
              currency: part.currency ?? currency,
              retailer: part.retailer,
              url: part.url,
              ...statusInfo
            };
          })
          .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

        return {
          label: build.label,
          currency,
          validation: matchedValidation,
          total: matchedSnapshot
            ? typeof matchedSnapshot.total === "number"
              ? matchedSnapshot.total
              : null
            : undefined,
          components,
          detailsUnavailable: components.length === 0,
          isLegacy: true
        };
      });
    }
  }

  return [];
}

export function enrichBuildsWithToolProducts(builds: DerivedBuild[], toolParts: ToolPart[]): DerivedBuild[] {
  const hasLegacy = builds.some((b) => b.isLegacy);
  if (!hasLegacy) return builds;

  const products: ProductRow[] = [];
  for (const part of toolParts) {
    if (part.type === "tool-search_products" && (part.state === "output-available" || (part as { output?: unknown }).output)) {
      const output = (part as { output?: { results?: ProductRow[] } }).output;
      if (Array.isArray(output?.results)) products.push(...output.results);
    }
  }
  if (products.length === 0) return builds;

  const byKey = new Map<string, ProductRow>();
  const byName = products.map((product) => ({ product, norm: normalize(product.name) }));
  for (const product of products) {
    if (product.registry_key) byKey.set(product.registry_key, product);
  }

  const findProduct = (name: string, key?: string): ProductRow | undefined => {
    if (key && byKey.has(key)) return byKey.get(key);
    const target = normalize(name);
    const directMatch = byName.find(({ norm }) => norm.includes(target) || target.includes(norm))?.product;
    if (directMatch) return directMatch;

    const targetTokens = target.split(" ").filter((t) => t.length > 1);
    if (targetTokens.length >= 2) {
      let bestMatch: ProductRow | undefined;
      let maxScore = 0;
      for (const { product, norm } of byName) {
        const normTokens = new Set(norm.split(" "));
        const matchCount = targetTokens.filter((t) => normTokens.has(t)).length;
        const score = matchCount / targetTokens.length;
        if (score >= 0.4 && matchCount > maxScore) {
          maxScore = matchCount;
          bestMatch = product;
        }
      }
      if (bestMatch) return bestMatch;
    }
    return undefined;
  };

  return builds.map((build) => {
    if (!build.isLegacy) return build;
    return {
      ...build,
      components: build.components.map((comp) => {
        if (comp.retailer && comp.url) return comp;
        const matched = findProduct(comp.name, comp.registryKey);
        if (!matched) return comp;
        return {
          ...comp,
          retailer: comp.retailer || matched.retailer,
          url: comp.url || matched.url,
          price: comp.price ?? matched.price,
          registryKey: comp.registryKey || matched.registry_key || undefined
        };
      })
    };
  });
}

/**
 * Derive proposed builds from explicit present_build tool activity or markdown text parts.
 * Multiple distinct builds render as labelled pill tabs in BuildCard.
 */
export function deriveBuilds(parts: unknown[], fallbackCurrency: string): DerivedBuild[] {
  if (!Array.isArray(parts) || parts.length === 0) return [];

  const toolParts = parts.filter(isToolPart);
  const toolBuilds = deriveBuildsFromToolParts(toolParts, fallbackCurrency);
  if (toolBuilds.length > 0) return toolBuilds;

  const textParts = parts.filter(isTextPart);
  if (textParts.length > 0) {
    const combinedText = textParts.map((p) => p.text).join("\n\n");
    const markdownBuilds = parseBuildsFromMarkdown(combinedText, fallbackCurrency);
    if (markdownBuilds.length > 0) {
      return enrichBuildsWithToolProducts(markTextDerivedBuilds(markdownBuilds, toolParts), toolParts);
    }
  }

  return [];
}

/**
 * Extract builds from a full message object, supporting both tool call parts and markdown text.
 */
export function extractBuildsFromMessage(
  message: { parts?: unknown[]; content?: unknown; role?: string },
  fallbackCurrency: string,
  extraToolParts?: ToolPart[]
): DerivedBuild[] {
  if (message.role === "user") return [];

  const parts = Array.isArray(message.parts) ? message.parts : [];
  const messageToolParts = parts.filter(isToolPart);
  const combinedToolParts = extraToolParts?.length ? [...extraToolParts, ...messageToolParts] : messageToolParts;

  const fromParts = deriveBuilds(parts, fallbackCurrency);
  if (fromParts.length > 0) {
    return enrichBuildsWithToolProducts(fromParts, combinedToolParts);
  }

  if (typeof message.content === "string" && message.content.trim()) {
    const markdownBuilds = parseBuildsFromMarkdown(message.content, fallbackCurrency);
    if (markdownBuilds.length > 0) {
      return enrichBuildsWithToolProducts(
        markTextDerivedBuilds(markdownBuilds, combinedToolParts),
        combinedToolParts
      );
    }
  }

  return [];
}

