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
const M2 = /\bm\.?2\b/i;
const TWO_FIVE = /\b2\.5\s*(?:inch|in|")?\b/i;
const PCIE_GEN = /\bgen\s*([345])\b/i;

export function parseStorageSpecs(name: string): RegistrySpec | undefined {
  const capacityMatch = CAPACITY.exec(name);
  const capacity_gb = capacityMatch
    ? Math.round(Number(capacityMatch[1]) * (capacityMatch[2].toLowerCase() === "tb" ? 1000 : 1))
    : undefined;

  const isNvme = NVME.test(name);
  const isSpinning = SPINNING.test(name);
  // Every consumer desktop HDD in this catalog is SATA; nothing else has shipped
  // for a decade. NVMe wins over a stray SATA token ("NVMe Gen4" beside "SATA III").
  const iface = isNvme ? "nvme" : SATA.test(name) || isSpinning ? "sata" : undefined;

  const form_factor = M2.test(name)
    ? "m2-2280"
    : isSpinning
      ? "3.5in"
      : TWO_FIVE.test(name) || (iface === "sata" && !isNvme)
        ? "2.5in"
        : undefined;

  const pcieMatch = isNvme ? PCIE_GEN.exec(name) : null;

  // Nothing readable means nothing derived - do not hand back an empty shell that
  // would read as a resolved component.
  if (capacity_gb === undefined && !iface) return undefined;

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

  const isItx = /\b(MINI[- ]?ITX|ITX)\b/.test(norm);
  const isMatx = /\b(MICRO[- ]?ATX|MATX|M-ATX)\b/.test(norm) || /\b[A-Z]\d{3}M\b/.test(norm) || /\b[A-Z]\d{3}M-/.test(norm);
  const form_factor = isItx ? "Mini-ITX" : isMatx ? "Micro-ATX" : "ATX";

  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    socket,
    ddr,
    chipset,
    form_factor,
    m2_slots: /A520|H610|H410|A320/.test(chipset ?? "") ? 1 : 2,
    sata_ports: 4
  };
}

export function parsePsuSpecs(name: string): RegistrySpec | undefined {
  const wMatch = name.match(/(\d{3,4})\s*W\b/i) || name.match(/\b(450|500|550|600|650|700|750|800|850|1000|1200|1300|1600)\b/);
  const wattage = wMatch ? parseInt(wMatch[1] || wMatch[0], 10) : undefined;
  if (!wattage || wattage < 250 || wattage > 2000) return undefined;

  const isSfx = /\bSFX\b/i.test(name);
  const form_factor = isSfx ? "SFX" : "ATX";

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

  const kitMatch = name.match(/(\d+)\s*x\s*(\d+)\s*GB/i);
  const singleMatch = name.match(/(\d+)\s*GB\b/i);
  const capacity_gb = kitMatch
    ? parseInt(kitMatch[1], 10) * parseInt(kitMatch[2], 10)
    : singleMatch
      ? parseInt(singleMatch[1], 10)
      : undefined;

  const speedMatch = name.match(/(\d{4})\s*MHz\b/i) || name.match(/DDR[45]-(\d{4})\b/i);
  const speed_mhz = speedMatch ? parseInt(speedMatch[1], 10) : undefined;

  if (!ddr && !capacity_gb) return undefined;

  return {
    brand: name.trim().split(/\s+/)[0] ?? "",
    model: name.trim(),
    aliases: [name.trim()],
    ...(ddr ? { ddr } : {}),
    ...(capacity_gb ? { capacity_gb } : {}),
    ...(speed_mhz ? { speed_mhz } : {})
  };
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
