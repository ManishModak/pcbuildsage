import type { BuildIssue, ProductRow, ValidationResult } from "@/types/client";
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
  findAllBuildVersions,
  type BuildVersion
} from "./build-versions";

export {
  validationStrip,
  computeValidationStats,
  ruleLabel,
  type StripBadge
};
export {
  findAllBuildVersions,
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
};

export type DerivedBuild = {
  /** Model-supplied name for the tradeoff this build makes, when it proposed several. */
  label?: string;
  components: BuildComponent[];
  currency: string;
  validation: ValidationResult | null;
};

function partLabel(part: unknown): { key?: string; name: string } {
  if (typeof part === "string") return { key: part, name: part };
  if (part && typeof part === "object") {
    const value = part as { key?: string; name?: string };
    return { key: value.key, name: value.name ?? value.key ?? "unknown" };
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
  const normCat = normalize(category);
  const normKey = key ? normalize(key) : undefined;
  const canonKey = key ? canonicalizePartName(key) : undefined;
  const normName = name ? normalize(name) : undefined;
  const canonName = name ? canonicalizePartName(name) : undefined;

  const matching = issues.filter((issue) =>
    issue.components.some((component) => {
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

  return { label, components, currency, validation };
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
    validation: null
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
    validation: null
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

function isComponentMatch(vPart: { key?: string; name: string }, bPartName: string): boolean {
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

function findMatchingValidation(
  build: { label?: string; parts?: Array<{ category: string; name: string }> },
  validateParts: ToolPart[]
): ValidationResult | null {
  if (!build.parts || build.parts.length === 0 || validateParts.length === 0) return null;

  const bMap = new Map<string, string[]>();
  for (const p of build.parts) {
    const normCat = normalizeCategory(p.category) ?? p.category.toLowerCase();
    const list = bMap.get(normCat) ?? [];
    list.push(p.name);
    bMap.set(normCat, list);
  }

  for (let i = validateParts.length - 1; i >= 0; i--) {
    const vPart = validateParts[i];
    const vInput = vPart.input as { label?: string; parts?: Record<string, unknown> } | undefined;
    const vValidation = (vPart as { output?: ValidationResult }).output;
    if (!vInput?.parts || !vValidation) continue;

    const vMap = new Map<string, Array<{ key?: string; name: string }>>();
    for (const [rawCategory, raw] of Object.entries(vInput.parts)) {
      const normCat = normalizeCategory(rawCategory) ?? rawCategory.toLowerCase();
      const items = Array.isArray(raw) ? raw : [raw];
      vMap.set(normCat, items.map(partLabel));
    }

    // Exact component-set identity: every category in build must exist in validation and vice-versa
    if (bMap.size !== vMap.size) continue;

    let allCategoriesMatch = true;
    for (const [cat, bList] of bMap.entries()) {
      const vList = vMap.get(cat);
      if (!vList || vList.length !== bList.length) {
        allCategoriesMatch = false;
        break;
      }

      // Check that every component in this category matches
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
        if (!foundMatch) {
          allCategoriesMatch = false;
          break;
        }
      }
      if (!allCategoriesMatch) break;
    }

    if (allCategoriesMatch) {
      return vValidation;
    }
  }

  return null;
}

export function deriveBuildsFromToolParts(
  parts: ToolPart[],
  fallbackCurrency: string,
  targetPresentPart?: ToolPart
): DerivedBuild[] {
  const presentPart =
    targetPresentPart ??
    [...parts]
      .reverse()
      .find(
        (part) =>
          (part.type === "tool-present_build" || part.toolName === "present_build") &&
          (part.state === "output-available" || part.state === "input-available" || Boolean(part.input))
      );

  if (presentPart) {
    const input = presentPart.input as
      | {
          builds?: Array<{
            label?: string;
            parts?: Array<{
              category: string;
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
        const matchedValidation = findMatchingValidation(build, validateParts);
        const currency = build.parts?.find((p) => p.currency)?.currency ?? fallbackCurrency;

        const components: BuildComponent[] = (build.parts || [])
          .map((part) => {
            const issue = matchedValidation
              ? findComponentIssue(
                  matchedValidation.issues ?? [],
                  part.category,
                  undefined,
                  part.name
                )
              : undefined;
            const statusInfo = decorateComponentStatus(issue, Boolean(matchedValidation));

            return {
              category: part.category,
              categoryLabel: CATEGORY_LABELS[part.category] ?? part.category,
              name: part.name,
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
          components
        };
      });
    }
  }

  return [];
}

export function enrichBuildsWithToolProducts(builds: DerivedBuild[], toolParts: ToolPart[]): DerivedBuild[] {
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

  return builds.map((build) => ({
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
  }));
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
      return enrichBuildsWithToolProducts(markdownBuilds, toolParts);
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
      return enrichBuildsWithToolProducts(markdownBuilds, combinedToolParts);
    }
  }

  return [];
}

