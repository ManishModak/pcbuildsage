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
const PCIE_GEN = /\bgen\s*([345])\b/i;

/** Chipset immediately followed by "I" (GIGABYTE B650I AORUS ULTRA, H810I):
 *  a Mini-ITX board. Plain chipset names (B650M, X670E, Z790) never end in I. */
export const DASHLESS_ITX_CHIPSET = /\b[ABHXZ]\d{3}[EM]?I\b/i;

export function parseStorageSpecs(name: string): RegistrySpec | undefined {
  const capacityMatch = CAPACITY.exec(name);
  const capacity_gb = capacityMatch
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

  const countFirst = name.match(/\b(\d+)\s*[x×]\s*(\d+)\s*GB\b/i);
  const capacityFirst = name.match(/\b(\d+)\s*GB\s*[x×]\s*(\d+)\b/i);
  const modules = countFirst ? Number(countFirst[1]) : capacityFirst ? Number(capacityFirst[2]) : undefined;
  const perModule = countFirst ? Number(countFirst[2]) : capacityFirst ? Number(capacityFirst[1]) : undefined;
  const singleMatch = name.match(/(\d+)\s*GB\b/i);
  const capacity_gb = modules && perModule
    ? modules * perModule
    : singleMatch ? Number(singleMatch[1]) : undefined;

  const speedMatch = name.match(/(\d{4})\s*MHz\b/i) || name.match(/DDR[45]-(\d{4})\b/i);
  const speed_mhz = speedMatch ? parseInt(speedMatch[1], 10) : undefined;

  if (!ddr && !capacity_gb) return undefined;

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
    ...(capacity_gb ? { capacity_gb } : {}),
    ...(speed_mhz ? { speed_mhz } : {}),
    ...(modules && perModule ? { modules } : {}),
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
