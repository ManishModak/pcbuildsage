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

/** Title parsers by category. Only storage is formulaic enough to read reliably. */
export function parseSpecsFromTitle(name: string, category?: string): RegistrySpec | undefined {
  return category === "storage" ? parseStorageSpecs(name) : undefined;
}
