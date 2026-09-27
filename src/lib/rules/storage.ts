/**
 * src/lib/rules/storage.ts
 *
 * Storage topology checks: interface support, M.2 slot accounting, SATA port
 * accounting, unknown-topology handling, and M.2 SATA protocol support.
 */
import { canonicalizeMemory } from "../spec-canonical";
import type { ResolvedSpec } from "../registry";
import type { BuildIssue } from "../rules-engine";
import { confidenceGate, lowNames, numberSpec, stringSpec, type CheckRecorder } from "./shared";

export function isM2Storage(drive: ResolvedSpec): boolean {
  const ff = drive.spec.form_factor ? canonicalizeMemory(drive.spec.form_factor) : "";
  return ff.includes("m2") || ff.startsWith("m.2");
}

export type StorageClass = "m2Nvme" | "unknownNvme" | "m2Sata" | "cabledSata";

export type ClassifiedStorage = Record<StorageClass, ResolvedSpec[]>;

/**
 * Single pass over interface-resolved drives, bucketing by connector +
 * protocol. Unknown-topology NVMe and M.2 SATA stay distinct classes so later
 * steps cannot conflate them.
 */
export function classifyInterfaces(
  interfaces: Array<{ drive: ResolvedSpec; value: string }>
): ClassifiedStorage {
  const bucket = (cls: StorageClass) =>
    interfaces
      .filter(({ drive, value }) => storageClass(drive, canonicalizeMemory(value)) === cls)
      .map(({ drive }) => drive);
  return {
    m2Nvme: bucket("m2Nvme"),
    unknownNvme: bucket("unknownNvme"),
    m2Sata: bucket("m2Sata"),
    cabledSata: bucket("cabledSata"),
  };
}

function storageClass(drive: ResolvedSpec, normInterface: string): StorageClass | undefined {
  if (normInterface === "nvme") return isM2Storage(drive) ? "m2Nvme" : "unknownNvme";
  if (normInterface === "sata") return isM2Storage(drive) ? "m2Sata" : "cabledSata";
  return undefined;
}

export function checkStorage(
  motherboard: ResolvedSpec | undefined,
  drives: ResolvedSpec[],
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!motherboard || drives.length === 0) return;
  const interfaces = drives.map((drive) => ({ drive, value: stringSpec(drive, "interface", issues) }));
  if (interfaces.some(({ value }) => value === undefined)) {
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      "Storage compatibility couldn't be verified due to missing drive interface specs."
    );
    return;
  }

  // 1. Unsupported or external interfaces (e.g. USB)
  // Unsupported interface never passes an empty check; leave unsupported interface checks unverified.
  const unsupported = interfaces.filter(({ value }) => {
    const norm = canonicalizeMemory(value);
    return norm !== "nvme" && norm !== "sata";
  });
  if (unsupported.length > 0) {
    const names = unsupported.map(({ drive, value }) => `${drive.spec.model || drive.key} (${value})`).join(", ");
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      `Storage drive interface cannot be verified for internal motherboard connection: ${names}.`
    );
    return;
  }

  // 2. Classify drives by physical connector and protocol in one pass:
  // - M.2 NVMe: interface nvme and M.2 form factor
  // - Unknown topology NVMe: interface nvme without M.2 form factor
  // - M.2 SATA: interface sata and M.2 form factor
  // - Cabled SATA: interface sata without M.2 form factor
  const resolved = interfaces.filter(
    (entry): entry is { drive: ResolvedSpec; value: string } => entry.value !== undefined
  );
  const { m2Nvme, unknownNvme, m2Sata, cabledSata } = classifyInterfaces(resolved);

  const totalM2Count = m2Nvme.length + m2Sata.length;
  const cabledSataCount = cabledSata.length;

  const m2Slots = totalM2Count > 0 ? numberSpec(motherboard, "m2_slots", issues) : undefined;
  const sataPorts = cabledSataCount > 0 ? numberSpec(motherboard, "sata_ports", issues) : undefined;

  if ((totalM2Count > 0 && m2Slots === undefined) || (cabledSataCount > 0 && sataPorts === undefined)) {
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      "Storage compatibility couldn't be verified due to missing motherboard slot/port specs."
    );
    return;
  }

  // 3. Physical M.2 slot count check
  if (totalM2Count > (m2Slots ?? 0)) {
    const msg = `${totalM2Count} M.2 drives require ${totalM2Count} M.2 slots; motherboard has ${m2Slots ?? 0}.`;
    recordCheck("storage", "failed", [motherboard.key, ...drives.map((drive) => drive.key)], msg);
    return;
  }

  // 4. Physical SATA port count check
  if (cabledSataCount > 0 && sataPorts !== undefined) {
    if (cabledSataCount > sataPorts) {
      const msg = `${cabledSataCount} SATA drives require ${cabledSataCount} SATA ports; motherboard has ${sataPorts}.`;
      recordCheck("storage", "failed", [motherboard.key, ...drives.map((drive) => drive.key)], msg);
      return;
    }
  }

  // 5. Unknown NVMe topology: "Do not assume every NVMe device is M.2. Unknown topology stays unverified, not automatically incompatible."
  if (unknownNvme.length > 0) {
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      "Storage topology could not be verified: NVMe drive form factor is not specified as M.2."
    );
    return;
  }

  // 6. M.2 SATA slot protocol support: "M.2 SATA cannot pass with zero M.2 slots; with unknown slot protocol support it stays unverified."
  if (m2Sata.length > 0 && motherboard.spec.m2_sata_supported !== true) {
    recordCheck(
      "storage",
      "unverified",
      [motherboard.key, ...drives.map((d) => d.key)],
      `Motherboard has ${m2Slots} M.2 slot(s), but M.2 SATA protocol support on these slots is unverified.`
    );
    return;
  }

  const segments = [
    m2Nvme.length > 0 ? `${m2Nvme.length} NVMe` : null,
    m2Sata.length > 0 ? `${m2Sata.length} M.2 SATA` : null,
    cabledSata.length > 0 ? `${cabledSata.length} SATA` : null,
  ].filter((segment): segment is string => segment !== null);
  recordCheck(
    "storage",
    "passed",
    [motherboard.key, ...drives.map((d) => d.key)],
    `Motherboard supports installed storage drives (${segments.join(", ")}).`
  );
  confidenceGate("storage", [motherboard, ...drives], issues, `Storage pass uses low-confidence researched specs for ${lowNames([motherboard, ...drives])}.`);
}
