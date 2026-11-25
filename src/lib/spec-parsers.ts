import type { RegistrySpec } from "./registry";

/**
 * Deterministic spec extraction from retailer product titles.
 *
 * Storage is the one category where curation does not scale: the registry covers
 * 7 of 288 drives, so spec filters and the M.2/SATA port rules were dead for
 * practically every product in the catalog. But storage titles are formulaic -
 * "Acer Predator GM7 1TB M.2 NVMe Gen4 7400MB/s Internal SSD" states every field
 * compatibility actually needs - so they can be read rather than researched.
 *
 * This is parsing, not inference: a field that the title does not state is left
 * undefined, which surfaces as needs_research and routes to consult. In
 * particular an M.2 slot does NOT imply NVMe - "Adata Ultimate SU650 512GB M.2
 * SSD" is an M.2 SATA drive - so the interface is only ever taken from an
 * explicit NVMe or SATA token.
 */

const CAPACITY = /(\d+(?:\.\d+)?)\s*(TB|GB)\b/i;
// "Addlink S68 256GB M.2 NNMe SSD" is a live catalog typo, not a distinct interface.
const NVME = /\bnv[mn]e\b|\bnnme\b/i;
const SATA = /\bsata\b/i;
const SPINNING = /\b(hdd|hard\s+disk|hard\s+drive)\b/i;
const EXTERNAL = /\b(external|portable|usb)\b/i;
// A bare accessory or cable mention is not a drive. External titles resolve only
// with credible drive evidence: a capacity plus a drive/storage indication.
const DRIVE_WORD = /\b(drive|ssd|hdd|storage|disk|enclosure)\b/i;
const M2 = /\bm\.?2\b/i;
const TWO_FIVE = /\b2\.5\s*(?:inch|in|")?\b/i;
// Require an explicit inch/form-factor unit so throughput strings like "3.5 GB/s"
// are never misread as 3.5-inch HDDs.
const THREE_FIVE = /\b3\.5\s*(?:"|''|[-\s]?(?:inch|in)\b)/i;
const EXPLICIT_SSD = /\b(?:ssd|nv[mn]e|nnme|m\.?2|solid\s+state)\b/i;
const PCIE_GEN = /\bgen\s*([345])\b/i;

/** Consumer/prosumer SSDs top out around 8-16 TB; desktop/external HDDs around 24-32 TB;
 *  sourced enterprise drives reach up to 128 TB. Values like 256TB, 512TB, 1000TB
 *  are retailer GB-as-TB typos. */
export const MAX_SSD_CAPACITY_GB = 16_000;
export const MAX_HDD_CAPACITY_GB = 32_000;
export const MAX_SOURCED_STORAGE_CAPACITY_GB = 128_000;
export const MAX_RAM_CAPACITY_GB = 512;
export const MAX_RAM_MODULES = 8;
export const MAX_RAM_MODULE_GB = 128;

/** Strict numeric parser: accepts only finite positive numbers or plain numeric strings. */
function parseStrictPositiveNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/** Parses an explicit capacity string such as "16GB" or "2TB" into GB. */
function parseCapacityTextGb(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(TB|GB)$/i);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.round(num * (match[2].toLowerCase() === "tb" ? 1000 : 1));
}

/** True when a storage title or form factor explicitly describes an SSD/NVMe/M.2 drive. */
export function isExplicitSsdStorage(text: string, formFactor?: unknown): boolean {
  if (EXPLICIT_SSD.test(text)) return true;
  if (typeof formFactor === "string") {
    const norm = formFactor.toLowerCase().replace(/[\s"_-]/g, "");
    if (norm.startsWith("m2")) return true;
  }
  return false;
}

/** True when a storage title or form factor explicitly describes a spinning HDD (SSD wins if both appear). */
export function isHddStorage(text: string, formFactor?: unknown): boolean {
  if (isExplicitSsdStorage(text, formFactor)) return false;
  if (typeof formFactor === "string" && formFactor.toLowerCase().replace(/[\s"_-]/g, "") === "3.5in") {
    return true;
  }
  return SPINNING.test(text) || THREE_FIVE.test(text);
}

/**
 * Returns `capacityGb` when it is finite, positive, and within realistic storage
 * bounds (<=16 TB for explicit SSD/NVMe/M.2 titles, <=32 TB for HDD or unspecified
 * desktop/external drives, <=128 TB for sourced enterprise specs); otherwise undefined.
 */
export function sanitizeStorageCapacityGb(
  capacityGb: number | undefined,
  text = "",
  formFactor?: unknown,
  options?: { sourced?: boolean }
): number | undefined {
  if (typeof capacityGb !== "number" || !Number.isFinite(capacityGb) || capacityGb <= 0) {
    return undefined;
  }
  const maxGb = options?.sourced
    ? MAX_SOURCED_STORAGE_CAPACITY_GB
    : isExplicitSsdStorage(text, formFactor)
      ? MAX_SSD_CAPACITY_GB
      : MAX_HDD_CAPACITY_GB;
  return capacityGb <= maxGb ? capacityGb : undefined;
}

/**
 * Returns `capacityGb` when it is finite, positive, and within realistic
 * desktop/workstation RAM bounds (<=512 GB); otherwise undefined.
 */
export function sanitizeRamCapacityGb(capacityGb: number | undefined): number | undefined {
  if (typeof capacityGb !== "number" || !Number.isFinite(capacityGb) || capacityGb <= 0) {
    return undefined;
  }
  return capacityGb <= MAX_RAM_CAPACITY_GB ? capacityGb : undefined;
}

export type ParsedRamKit =
  | { kind: "valid"; modules: number; capacity_gb: number }
  | { kind: "speed"; capacity_gb: number | undefined }
  | { kind: "invalid" };

/**
 * Parses explicit RAM kit notation ("2x16GB", "16GBx2", "2 x 8GB") while separating
 * memory-speed notation ("3200 x 16GB") from impossible kits ("4 x 256GB").
 * Shared by title parsing and module-count filtering.
 */
export function parseRamKit(text: string): ParsedRamKit | undefined {
  const countFirst = text.match(/\b(\d+)\s*[x×]\s*(\d+)\s*GB\b/i);
  if (countFirst) {
    const rawModules = Number(countFirst[1]);
    const rawPerModule = Number(countFirst[2]);
    // Speed x capacity strings (e.g. "3200 x 16GB", "6000 x 32GB") state MT/s, not stick count.
    if (Number.isInteger(rawModules) && rawModules >= 800) {
      return { kind: "speed", capacity_gb: sanitizeRamCapacityGb(rawPerModule) };
    }
    if (
      Number.isInteger(rawModules) &&
      rawModules >= 1 &&
      rawModules <= MAX_RAM_MODULES &&
      Number.isInteger(rawPerModule) &&
      rawPerModule >= 1 &&
      rawPerModule <= MAX_RAM_MODULE_GB &&
      rawModules * rawPerModule <= MAX_RAM_CAPACITY_GB
    ) {
      return { kind: "valid", modules: rawModules, capacity_gb: rawModules * rawPerModule };
    }
    return { kind: "invalid" };
  }

  const capacityFirst = text.match(/\b(\d+)\s*GB\s*[x×]\s*(\d+)\b/i);
  if (capacityFirst) {
    const rawPerModule = Number(capacityFirst[1]);
    const rawModules = Number(capacityFirst[2]);
    if (
      Number.isInteger(rawModules) &&
      rawModules >= 1 &&
      rawModules <= MAX_RAM_MODULES &&
      Number.isInteger(rawPerModule) &&
      rawPerModule >= 1 &&
      rawPerModule <= MAX_RAM_MODULE_GB &&
      rawModules * rawPerModule <= MAX_RAM_CAPACITY_GB
    ) {
      return { kind: "valid", modules: rawModules, capacity_gb: rawModules * rawPerModule };
    }
    return { kind: "invalid" };
  }

  return undefined;
}

/** Extracts the raw numeric capacity in GB explicitly stated in a title (before sanity bounds). */
export function extractRawTitleCapacityGb(category: string | undefined, title: string): number | undefined {
  const cat = category?.trim().toLowerCase();
  if (!title) return undefined;
  if (cat === "storage") {
    const match = CAPACITY.exec(title);
    if (!match) return undefined;
    const rawGb = Math.round(Number(match[1]) * (match[2].toLowerCase() === "tb" ? 1000 : 1));
    return Number.isFinite(rawGb) && rawGb > 0 ? rawGb : undefined;
  }
  return undefined;
}

/**
 * True when a listing title explicitly states a storage or RAM capacity that falls
 * outside realistic bounds (e.g. "Acer FA100 256TB M.2 NVMe" or "4 x 256GB DDR5"),
 * unless a sourced spec explicitly confirms that exact storage capacity within
 * enterprise bounds (<= 128 TB).
 */
export function hasImplausibleTitleCapacity(
  category: string | undefined,
  title: string,
  options?: { sourcedSpecCapacityGb?: number }
): boolean {
  const cat = category?.trim().toLowerCase();
  if (!title) return false;
  if (cat === "storage") {
    const rawGb = extractRawTitleCapacityGb(cat, title);
    if (rawGb === undefined) return false;
    if (
      options?.sourcedSpecCapacityGb !== undefined &&
      options.sourcedSpecCapacityGb === rawGb &&
      sanitizeStorageCapacityGb(rawGb, title, undefined, { sourced: true }) !== undefined
    ) {
      return false;
    }
    return sanitizeStorageCapacityGb(rawGb, title) === undefined;
  }
  if (cat === "ram") {
    const kit = parseRamKit(title);
    if (kit?.kind === "invalid") return true;
    if (kit?.kind === "speed") return kit.capacity_gb === undefined;
    if (kit?.kind === "valid") return false;
    const single = title.match(/(\d+)\s*GB\b/i);
    if (!single) return false;
    return sanitizeRamCapacityGb(Number(single[1])) === undefined;
  }
  return false;
}

/**
 * Extracts and validates `spec.capacity_gb` for storage and RAM products so
 * impossible capacities (whether from title parsing, research cache, or raw
 * DB JSON) are treated as unknown. Never throws on malformed JSON values.
 */
export function sanitizeSpecCapacityGb(
  category: string | undefined,
  spec: { capacity_gb?: unknown; capacity?: unknown; form_factor?: unknown; model?: unknown; aliases?: unknown; sources?: unknown } | undefined,
  productName = "",
  options?: { sourced?: boolean }
): number | undefined {
  if (!spec || typeof spec !== "object") return undefined;
  const cat = category?.trim().toLowerCase();
  const num =
    spec.capacity_gb !== undefined
      ? parseStrictPositiveNumber(spec.capacity_gb)
      : parseCapacityTextGb(spec.capacity);
  const sourced = options?.sourced ?? (Array.isArray(spec.sources) && spec.sources.length > 0);
  if (
    (cat === "storage" || cat === "ram") &&
    productName &&
    hasImplausibleTitleCapacity(cat, productName, { sourcedSpecCapacityGb: sourced ? num : undefined })
  ) {
    return undefined;
  }
  if (num === undefined) return undefined;
  if (cat === "storage") {
    const text = [
      productName,
      typeof spec.model === "string" ? spec.model : "",
      ...(Array.isArray(spec.aliases) ? spec.aliases.filter((a): a is string => typeof a === "string") : [])
    ].join(" ");
    return sanitizeStorageCapacityGb(num, text, spec.form_factor, { sourced });
  }
  if (cat === "ram") {
    return sanitizeRamCapacityGb(num);
  }
  return num;
}

/**
 * Normalizes both `capacity_gb` and string `capacity` in one place for storage/RAM
 * specs: populates a clean numeric `capacity_gb` when valid, and removes both fields
 * when the capacity is malformed, implausible, or contradicted by an implausible title.
 */
export function normalizeSpecCapacities<T extends Record<string, unknown>>(
  category: string | undefined,
  spec: T | undefined,
  productName = "",
  options?: { sourced?: boolean }
): T | undefined {
  if (!spec || typeof spec !== "object") return spec;
  const cat = category?.trim().toLowerCase();
  if (cat !== "storage" && cat !== "ram") return spec;
  if (spec.capacity_gb === undefined && spec.capacity === undefined) return spec;

  const validCap = sanitizeSpecCapacityGb(cat, spec, productName, options);
  const next: Record<string, unknown> = { ...spec };
  if (validCap === undefined) {
    delete next.capacity_gb;
    delete next.capacity;
    return next as T;
  }

  next.capacity_gb = validCap;
  if (typeof next.capacity === "string") {
    const parsedStr = parseCapacityTextGb(next.capacity);
    if (parsedStr !== undefined) {
      const strValid =
        cat === "storage"
          ? sanitizeStorageCapacityGb(parsedStr, productName, spec.form_factor, {
              sourced: options?.sourced ?? (Array.isArray(spec.sources) && spec.sources.length > 0)
            })
          : sanitizeRamCapacityGb(parsedStr);
      if (strValid === undefined) {
        delete next.capacity;
      }
    }
  }
  return next as T;
}

/** Chipset immediately followed by "I" (GIGABYTE B650I AORUS ULTRA, H810I):
 *  a Mini-ITX board. Plain chipset names (B650M, X670E, Z790) never end in I. */
export const DASHLESS_ITX_CHIPSET = /\b[ABHXZ]\d{3}[EM]?I\b/i;

export function parseStorageSpecs(name: string): RegistrySpec | undefined {
  const capacityMatch = CAPACITY.exec(name);
  const rawCapacityGb = capacityMatch
    ? Math.round(Number(capacityMatch[1]) * (capacityMatch[2].toLowerCase() === "tb" ? 1000 : 1))
    : undefined;

  const isExternal = EXTERNAL.test(name);
  const isNvme = !isExternal && NVME.test(name);
  const isSpinning = !isExternal && SPINNING.test(name);
  // Every consumer desktop HDD in this catalog is SATA; nothing else has shipped
  // for a decade. NVMe wins over a stray SATA token ("NVMe Gen4" beside "SATA III").
  // External / portable drives use USB and must not be classified as internal SATA/3.5in.
  const iface = isExternal
    ? "usb"
    : isNvme
      ? "nvme"
      : SATA.test(name) || isSpinning
        ? "sata"
        : undefined;

  const form_factor = isExternal
    ? undefined
    : M2.test(name)
      ? "m2-2280"
      : isSpinning
        ? "3.5in"
        : TWO_FIVE.test(name) || (iface === "sata" && !isNvme)
          ? "2.5in"
          : undefined;

  const capacity_gb = sanitizeStorageCapacityGb(rawCapacityGb, name, form_factor);
  const pcieMatch = isNvme ? PCIE_GEN.exec(name) : null;

  // Nothing readable means nothing derived - do not hand back an empty shell that
  // would read as a resolved component. External accessories without drive
  // evidence (e.g. "USB Cable") are not drives either.
  if (capacity_gb === undefined && !iface) return undefined;
  if (isExternal && (capacity_gb === undefined || !DRIVE_WORD.test(name))) return undefined;

  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    ...(capacity_gb !== undefined ? { capacity_gb } : {}),
    ...(iface ? { interface: iface } : {}),
    ...(form_factor ? { form_factor } : {}),
    ...(pcieMatch ? { pcie_gen: Number(pcieMatch[1]) } : {})
  };
}

export function parseMotherboardSpecs(name: string): RegistrySpec | undefined {
  const norm = name.toUpperCase();
  let socket: string | undefined;
  let ddr: string | undefined;
  let chipset: string | undefined;

  const am4 = norm.match(/\b(B550|B450|A520|X570|B350|A320|X470|X370)\w*\b/);
  const am5 = norm.match(/\b(B650|B650E|A620|X670|X670E|B850|X870|X870E)\w*\b/);
  const lga1700 = norm.match(/\b(Z790|B760|H610|B660|Z690|H670)\w*\b/);
  const lga1851 = norm.match(/\b(Z890|B860|H810)\w*\b/);
  const lga1200 = norm.match(/\b(Z590|B560|H510|Z490|B460|H410)\w*\b/);

  if (am4) {
    socket = "AM4";
    ddr = "DDR4";
    chipset = am4[1];
  } else if (am5) {
    socket = "AM5";
    ddr = "DDR5";
    chipset = am5[1];
  } else if (lga1700) {
    socket = "LGA 1700";
    ddr = /DDR4|D4\b/.test(norm) ? "DDR4" : "DDR5";
    chipset = lga1700[1];
  } else if (lga1851) {
    socket = "LGA 1851";
    ddr = "DDR5";
    chipset = lga1851[1];
  } else if (lga1200) {
    socket = "LGA 1200";
    ddr = "DDR4";
    chipset = lga1200[1];
  }

  if (!socket) return undefined;

  // Only record a memory generation the title actually states. AM4 is DDR4-only
  // and AM5 / LGA 1851 / LGA 1200 each take a single generation, so the socket
  // implies it; LGA 1700 boards ship in both DDR4 and DDR5 variants (Intel ARK
  // lists both memory types for LGA 1700 CPUs), so an LGA 1700 title without an
  // explicit DDR4/DDR5 (or D4/D5 suffix) token leaves ddr unknown - downstream
  // rules then report unverified instead of passing on a guessed generation.
  if (socket === "LGA 1700") {
    const saysDdr5 = /\bDDR5\b/.test(norm) || /(?:^|[\s\-/])D5\b/.test(norm);
    const saysDdr4 = /\bDDR4\b/.test(norm) || /(?:^|[\s\-/])D4\b/.test(norm);
    ddr = saysDdr5 && !saysDdr4 ? "DDR5" : saysDdr4 && !saysDdr5 ? "DDR4" : undefined;
  }

  // Only record a form factor the title actually states. A bare chipset+model
  // title (e.g. "B650M Pro RS" with no ATX/M-ATX/ITX token) leaves form_factor
  // unknown so board-fit reports unverified. ASUS-style "-I" suffixes
  // (B650E-I, Z790-I) and GIGABYTE-style dashless ones (B650I, H810I) denote
  // Mini-ITX boards.
  const isItx = /\bMINI[-\s]?ITX\b/.test(norm) || /\bITX\b/.test(norm) || /\b[A-Z]+\d+[A-Z]*-I\b/.test(norm) || DASHLESS_ITX_CHIPSET.test(norm);
  const isEatx = /\bE[-\s]?ATX\b/.test(norm);
  const isMatx =
    /\bMICRO[-\s]?ATX\b/.test(norm) ||
    /\bM[-\s]?ATX\b/.test(norm) ||
    /\bU[-\s]?ATX\b/.test(norm) ||
    /\b[A-Z]\d{3}M\b/.test(norm) ||
    /\b[A-Z]\d{3}M-/.test(norm);
  const form_factor = isItx ? "Mini-ITX" : isEatx ? "E-ATX" : isMatx ? "Micro-ATX" : /\bATX\b/.test(norm) ? "ATX" : undefined;

  // m2_slots and sata_ports are deliberately NOT defaulted: same-name boards
  // disagree (B450 boards commonly have 1 M.2 slot, not 2), and an invented
  // count would let the storage rule pass on fiction. Unknown counts surface
  // as unverified and route to consult.
  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    socket,
    ...(ddr ? { ddr } : {}),
    ...(chipset ? { chipset } : {}),
    ...(form_factor ? { form_factor } : {})
  };
}

export function parsePsuSpecs(name: string): RegistrySpec | undefined {
  const matches = Array.from(name.matchAll(/(?<!\d)(\d{3,4})\s*(?:watts?|w)\b/gi));
  const candidateWattages = matches.map((m) => parseInt(m[1], 10));
  const uniqueWattages = Array.from(new Set(candidateWattages));

  // A bare model number is not treated as a measured wattage (uniqueWattages.length === 0).
  // Conflicting explicit values stay unresolved (uniqueWattages.length > 1).
  if (uniqueWattages.length !== 1) return undefined;

  const wattage = uniqueWattages[0];
  if (wattage < 250 || wattage > 2000) return undefined;

  const isSfxL = /\bSFX[-\s]?L\b/i.test(name);
  const isSfx = /\bSFX\b/i.test(name);
  // SFX-L is a distinct, larger standard: detect it before the bare SFX token,
  // which would otherwise also match inside "SFX-L".
  const form_factor = isSfxL ? "SFX-L" : isSfx ? "SFX" : "ATX";

  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    wattage,
    wattage_w: wattage,
    form_factor
  };
}

export function parseRamSpecs(name: string): RegistrySpec | undefined {
  const ddrMatch = name.match(/\bDDR([45])\b/i);
  const ddr = ddrMatch ? `DDR${ddrMatch[1]}` : undefined;

  const kit = parseRamKit(name);
  const modules = kit?.kind === "valid" ? kit.modules : undefined;
  const capacity_gb =
    kit?.kind === "valid"
      ? kit.capacity_gb
      : kit?.kind === "speed"
        ? kit.capacity_gb
        : kit?.kind === "invalid"
          ? undefined
          : (() => {
              const singleMatch = name.match(/(\d+)\s*GB\b/i);
              return singleMatch ? sanitizeRamCapacityGb(Number(singleMatch[1])) : undefined;
            })();

  const speedMatch = name.match(/(\d{4})\s*MHz\b/i) || name.match(/DDR[45]-(\d{4})\b/i);
  const speed_mhz = speedMatch ? parseInt(speedMatch[1], 10) : undefined;

  if (!ddr && capacity_gb === undefined) return undefined;

  // Physical stick type is only recorded when the title states it. Laptop /
  // notebook SO-DIMM sticks do not fit desktop DIMM slots, so carrying this
  // signal lets the DDR rule block them instead of passing on generation alone.
  const isSodimm = statesSodimm(name);
  const isDesktopDimm = /\bUDIMM\b/i.test(name) || /\bDESKTOP\b/i.test(name);

  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    ...(ddr ? { ddr } : {}),
    ...(capacity_gb !== undefined ? { capacity_gb } : {}),
    ...(speed_mhz ? { speed_mhz } : {}),
    ...(modules !== undefined ? { modules } : {}),
    ...(isSodimm ? { form_factor: "sodimm" } : isDesktopDimm ? { form_factor: "dimm" } : {})
  };
}

/**
 * True when a RAM title/model states laptop SO-DIMM packaging: an explicit
 * SODIMM/SO-DIMM token, or laptop/notebook wording that is laptop-only.
 * "for Desktop and Laptop" and "(not for laptop)" are not SO-DIMM claims.
 * Shared by the title parser, the registry conflict guard and the DDR rule.
 */
export function statesSodimm(text: string): boolean {
  if (/\bSO[-\s]?DIMMS?\b/i.test(text)) return true;
  if (!/\b(?:LAPTOP|NOTEBOOK)S?\b/i.test(text)) return false;
  if (/\bDESKTOPS?\b/i.test(text)) return false;
  if (/\b(?:not|non)[-\s]+(?:for[-\s]+)?(?:a[-\s]+)?(?:laptop|notebook)/i.test(text)) return false;
  return true;
}

export type CpuPackageInfo = {
  cooler_included: "included" | "not_included" | "unknown";
  cooler_name?: string;
};

export function parseCpuPackage(name: string): CpuPackageInfo {
  const norm = name.toLowerCase();

  // Cooler name detection
  let cooler_name: string | undefined;
  if (/\bwraith\s+prism\b/i.test(norm)) {
    cooler_name = "AMD Wraith Prism";
  } else if (/\bwraith\s+stealth\b/i.test(norm)) {
    cooler_name = "AMD Wraith Stealth";
  } else if (/\blaminar\s+rm1\b/i.test(norm) || /\bintel\s+laminar\b/i.test(norm)) {
    cooler_name = "Intel Laminar RM1";
  } else if (/\bwith\s+wraith\b/i.test(norm)) {
    cooler_name = "AMD Wraith Stealth";
  }

  // Explicit no-cooler wording
  const explicitNoCoolerPatterns = [
    /\bwithout\s+cooler\b/i,
    /\bno\s+cooler\b/i,
    /\bw\/o\s+cooler\b/i,
    /\bcooler\s+not\s+included\b/i
  ];
  // Generic oem/tray labels
  const genericNoCoolerPatterns = [
    /\btray\b/i,
    /\boem\b/i
  ];

  // Explicit inclusion keywords
  const explicitIncludedPatterns = [
    /\bwith\s+wraith\b/i,
    /\bwith\s+(?:stock\s+)?cooler\b/i,
    /\bboxed\s+with\s+cooler\b/i,
    /\bboxed\s*\(\s*with\s+fan\s*\)/i,
    /\bwith\s+fan\b/i,
    /\bwith\s+(?:amd\s+|intel\s+)?(?:wraith|laminar)\b/i
  ];

  const hasExplicitNoCooler = explicitNoCoolerPatterns.some((p) => p.test(norm));
  const hasGenericNoCooler = genericNoCoolerPatterns.some((p) => p.test(norm));
  const hasExplicitIncluded = explicitIncludedPatterns.some((p) => p.test(norm));

  // Conflicting statements stay unknown
  if (hasExplicitNoCooler && hasExplicitIncluded) {
    return { cooler_included: "unknown" };
  }

  // Explicit no-cooler wording must NOT be overridden merely because a cooler name appears
  if (hasExplicitNoCooler) {
    return { cooler_included: "not_included" };
  }

  // Explicit inclusion keywords can override generic oem/tray labels
  if (hasExplicitIncluded) {
    return {
      cooler_included: "included",
      ...(cooler_name ? { cooler_name } : {})
    };
  }

  // Generic oem/tray labels without explicit inclusion
  if (hasGenericNoCooler) {
    return { cooler_included: "not_included" };
  }

  // If a known cooler name is present without negative clues, it's included
  if (cooler_name !== undefined) {
    return {
      cooler_included: "included",
      cooler_name
    };
  }

  return { cooler_included: "unknown" };
}

export function parseGpuSpecs(name: string): RegistrySpec | undefined {
  let length_mm: number | undefined;

  // Accept dimensions ONLY when context explicitly identifies card length
  const lengthMatch =
    name.match(/(?:card\s+)?length[:\s]+(\d{2,3}(?:\.\d+)?)\s*mm\b/i) ??
    name.match(/(\d{2,3}(?:\.\d+)?)\s*mm\s+(?:card\s+)?length\b/i);

  if (lengthMatch) {
    const val = parseFloat(lengthMatch[1]);
    if (val >= 100 && val <= 500) {
      length_mm = Math.round(val);
    }
  } else {
    // Dimensions format: e.g. "dimensions: 304 x 137 x 61 mm" or "dimensions: 304x137x61mm"
    const dimMatch = name.match(
      /dimensions?[:\s]+(\d{2,3}(?:\.\d+)?)\s*(?:mm)?\s*(?:[x*×])\s*(\d{2,3}(?:\.\d+)?)\s*(?:mm)?\s*(?:[x*×])\s*(\d{2,3}(?:\.\d+)?)\s*mm\b/i
    );
    if (dimMatch) {
      const d1 = parseFloat(dimMatch[1]);
      const d2 = parseFloat(dimMatch[2]);
      const d3 = parseFloat(dimMatch[3]);
      const maxDim = Math.max(d1, d2, d3);
      if (maxDim >= 100 && maxDim <= 500) {
        length_mm = Math.round(maxDim);
      }
    }
  }

  if (length_mm === undefined) return undefined;

  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    length_mm
  };
}

/** Title parsers by category for deterministic extraction from retailer listings. */
export function parseSpecsFromTitle(name: string, category?: string): RegistrySpec | undefined {
  if (category === "storage") return parseStorageSpecs(name);
  if (category === "motherboard") return parseMotherboardSpecs(name);
  if (category === "psu") return parsePsuSpecs(name);
  if (category === "ram") return parseRamSpecs(name);
  if (category === "gpu") return parseGpuSpecs(name);
  if (category === "cpu") {
    const pkg = parseCpuPackage(name);
    if (pkg.cooler_included === "unknown") return undefined;
    return {
      brand: name.trim().split(/\s+/)[0] ?? "",
      model: name.trim(),
      aliases: [name.trim()],
      cooler_included: pkg.cooler_included,
      ...(pkg.cooler_name ? { cooler_name: pkg.cooler_name } : {})
    };
  }
  return undefined;
}
