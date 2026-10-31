/**
 * src/lib/rules/cpu-support.ts
 *
 * Chipset x CPU-generation support: same-socket pairings that still need a
 * BIOS update, and pairings the vendor declares unsupported.
 *
 * - B450 / X470 / A520 boards predate Ryzen 5000: vendors released
 *   AGESA updates for it (GIGABYTE Dec 2020 BIOS F60 for X470/B450:
 *   https://www.gigabyte.com/Press/News/1866 ; ASRock BIOS updates covering
 *   500-series, B450 and A520:
 *   https://www.asrock.com/news/index.us.asp?iD=4723), but a board on
 *   factory BIOS may not boot a Ryzen 5000 CPU until updated.
 * - Intel 600-series boards predate 13th/14th gen; Intel states 600- and
 *   700-series boards require a BIOS update to boot 13th/14th gen CPUs
 *   (Intel article 000092294:
 *   https://www.intel.com/content/www/us/en/support/articles/000092294/processors.html).
 *   700-series launched with 13th gen, so only 14th gen is flagged there.
 * - AM4 pairings follow AMD's AM4 chipset compatibility matrix
 *   (https://www.amd.com/en/products/processors/chipsets/am4.html, re-read
 *   2026-09-29), encoded row for row in AM4_SUPPORT below:
 *   - "X" on a 500-series board (X570/B550/A520) fails: those boards' BIOSes
 *     dropped the older CPUs, so board makers don't list them either.
 *   - "X" on a 300/400-series board is unverified, not failed: AMD doesn't
 *     guarantee it, but some boards list the CPU anyway (board CPU support
 *     list decides).
 *   - "Selective Beta BIOS update needed" (300-series + Ryzen 3000/4000/5000)
 *     is unverified with a "check the CPU support list" message. (GIGABYTE's
 *     statement that its A320 boards don't support the Ryzen 5 5500,
 *     press/news/1978, could not be re-fetched, so it isn't used as a
 *     blocking source.)
 *
 * Anything the rule cannot identify (unknown chipset, unparseable CPU
 * generation, cross-platform pairing) is left to the socket rule - this rule
 * stays silent rather than guessing.
 */
import type { ResolvedSpec } from "../registry";
import type { BuildIssue } from "../rules-engine";
import { untrusted, type CheckRecorder } from "./shared";

/** One cell of AMD's AM4 matrix: supported, unsupported ("X"), or
 *  "Selective Beta BIOS update needed". */
type Am4Cell = "yes" | "no" | "beta";

/** AMD's AM4 matrix columns, in the page's order. */
const AM4_COLUMNS = ["Athlon", "Ryzen 1000", "Ryzen 2000G", "Ryzen 2000", "Ryzen 3000G", "Ryzen 3000", "Ryzen 4000", "Ryzen 5000"] as const;
type Am4Column = (typeof AM4_COLUMNS)[number];

/** AMD's AM4 matrix rows, one cell per AM4_COLUMNS entry. Chipsets missing
 *  here (B550A, PRO 5xx, X300/B300/A300) aren't on AMD's matrix: the rule
 *  stays silent for them. */
const AM4_SUPPORT: Record<string, readonly Am4Cell[]> = {
  X570: ["no", "no", "no", "yes", "yes", "yes", "yes", "yes"],
  B550: ["no", "no", "no", "no", "no", "yes", "yes", "yes"],
  A520: ["no", "no", "no", "no", "no", "yes", "yes", "yes"],
  X470: ["yes", "yes", "yes", "yes", "yes", "yes", "yes", "yes"],
  B450: ["no", "no", "no", "yes", "yes", "yes", "yes", "yes"],
  X370: ["no", "yes", "yes", "yes", "yes", "beta", "beta", "beta"],
  B350: ["no", "yes", "yes", "yes", "yes", "beta", "beta", "beta"],
  A320: ["yes", "yes", "yes", "yes", "yes", "no", "beta", "beta"]
};

type CpuPlatform = "AM4" | "AM5" | "LGA1700" | "LGA1851";

type CpuIdentity = {
  platform: CpuPlatform;
  series: string;
  /** Ryzen G/GE APU (e.g. 3200G, 5600G) - matters for pre-Zen 3 support. */
  apu?: boolean;
  /** 2024 AM4 refresh SKU (5600GT, 5500GT, 5600T, 5700X3D) that needs a
   *  newer AGESA than launch-era Ryzen 5000 BIOSes carry. */
  am4Refresh2024?: boolean;
};

/**
 * CPU platform + generation read deterministically off the model name,
 * e.g. i9-14900K -> LGA1700/14th gen, Ryzen 5 5600 -> AM4/Ryzen 5000,
 * Core Ultra 7 265K -> LGA1851. Returns undefined when the name does not
 * state a recognizable desktop CPU.
 */
export function inferCpuIdentity(cpu: ResolvedSpec): CpuIdentity | undefined {
  const text = `${cpu.spec.brand ?? ""} ${cpu.spec.model ?? ""} ${cpu.key}`;

  // Suffix letters (265K, 245KF) are part of the model number, so no \b
  // directly after the digits.
  const ultra = text.match(/\bultra[\s\-]*[3579][\s\-]*(2)\d{2}[a-z]*\b/i);
  if (ultra) return { platform: "LGA1851", series: "Series 2" };

  const intel = text.match(/\bi[\s\-]?[3579][\-\s]?(\d{2})\d{2,3}[a-z]*\b/i);
  if (intel) {
    const gen = intel[1];
    if (gen === "12" || gen === "13" || gen === "14") {
      return { platform: "LGA1700", series: `${gen}th gen` };
    }
    return undefined;
  }

  // Athlon 3000G / 200GE / 220GE / 240GE / 300GE are the AM4 Athlons.
  if (/\bathlon\b.*\b(?:3000G|[23]\d0GE)\b/i.test(text)) return { platform: "AM4", series: "Athlon", apu: true };

  const ryzen = text.match(/\bryzen[\s\-]*(?:\d[\s\-]*)?(\d)(\d{3})(?![0-9])([a-z0-9]*)/i);
  if (ryzen) {
    const seriesDigit = ryzen[1];
    const series = `${seriesDigit}000`;
    const suffix = ryzen[3].toUpperCase();
    const apu = /^GE?$|^GT$/.test(suffix);
    if (seriesDigit >= "7") return { platform: "AM5", series: `Ryzen ${series}` };
    if (seriesDigit === "5") {
      // Desktop Ryzen 5000 (incl. 5500/5600/5700X/5800X3D) is AM4.
      const model = `${seriesDigit}${ryzen[2]}${suffix}`;
      const am4Refresh2024 = /^(5600GT|5500GT|5600T|5700X3D)$/.test(model);
      return { platform: "AM4", series: `Ryzen ${series}`, apu, ...(am4Refresh2024 ? { am4Refresh2024 } : {}) };
    }
    if (seriesDigit >= "1" && seriesDigit <= "4") return { platform: "AM4", series: `Ryzen ${series}`, apu };
  }

  return undefined;
}

/** The AMD AM4 matrix column a CPU falls under. */
function am4Column(identity: CpuIdentity): Am4Column {
  if (identity.series === "Ryzen 2000" || identity.series === "Ryzen 3000") {
    return identity.apu ? `${identity.series}G` : identity.series;
  }
  return identity.series as Am4Column;
}

/** "Ryzen 3000, 4000 or 5000" - the columns a matrix row supports. */
function supportedColumns(row: readonly Am4Cell[]): string {
  let ryzenSeen = false;
  const names = AM4_COLUMNS.filter((_, i) => row[i] === "yes").map((c) => {
    if (!c.startsWith("Ryzen ")) return c;
    const name = ryzenSeen ? c.slice("Ryzen ".length) : c;
    ryzenSeen = true;
    return name;
  });
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names.join("");
}

type ChipsetFamily = "am4-300" | "am4-400" | "am4-500" | "lga1700-600" | "lga1700-700" | "lga1851-800";

function compactChipset(chipset: string): string {
  return chipset.toUpperCase().replace(/[\s\-_]/g, "");
}

function chipsetFamily(chipset: string): ChipsetFamily | undefined {
  const compact = compactChipset(chipset);
  if (/^(X370|B350|A320)$/.test(compact)) return "am4-300";
  if (/^(X470|B450)$/.test(compact)) return "am4-400";
  if (/^(X570|B550|A520)$/.test(compact)) return "am4-500";
  if (/^(Z690|H670|B660|H610)$/.test(compact)) return "lga1700-600";
  if (/^(Z790|H770|B760)$/.test(compact)) return "lga1700-700";
  if (/^(Z890|B860|H810)$/.test(compact)) return "lga1851-800";
  return undefined;
}

/** Routine BIOS note for pairings current retail stock almost always meets:
 *  the check passes and an advisory tells older-stock buyers what to check. */
function biosAdvisory(
  recordCheck: CheckRecorder,
  issues: BuildIssue[],
  components: string[],
  chipset: string,
  cpuName: string,
  updateHint: string
) {
  recordCheck("cpu_support", "passed", components, `Chipset ${chipset} supports ${cpuName} with a BIOS that includes it.`);
  issues.push({
    severity: "advisory",
    rule: "cpu_support",
    components,
    detail: `${chipset} boards need a BIOS with ${cpuName} support. Boards made since 2023 usually ship with a compatible BIOS; check the board's CPU support list if it's older stock (${updateHint}).`
  });
}

export function checkCpuSupport(
  cpu: ResolvedSpec | undefined,
  motherboard: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!cpu || !motherboard) return;
  // A board without a chipset spec (older synthetic fixtures, title-derived
  // boards) carries no generation signal: stay silent rather than demanding
  // research for a field this rule merely consults. stringSpec is deliberately
  // not used here - a missing chipset must not add noise.
  const chipsetRaw = motherboard.spec.chipset;
  if (typeof chipsetRaw !== "string" || chipsetRaw.length === 0) return;
  if (untrusted(motherboard, issues)) return;
  const chipset = chipsetRaw;
  const compact = compactChipset(chipset);
  const family = chipsetFamily(chipset);
  const identity = inferCpuIdentity(cpu);
  if (!family || !identity) return;

  const components = [cpu.key, motherboard.key];
  const cpuName = cpu.spec.model || cpu.key;

  if (identity.platform === "AM4" && family.startsWith("am4")) {
    const row = AM4_SUPPORT[compact];
    if (!row) return;
    const cell = row[AM4_COLUMNS.indexOf(am4Column(identity))];
    if (!cell) return;
    if (cell === "no" && family === "am4-500") {
      recordCheck("cpu_support", "failed", components,
        `${chipset} boards don't support ${cpuName} (AMD's AM4 compatibility chart). Pick a ${supportedColumns(row)} CPU instead.`);
      return;
    }
    if (cell === "no") {
      recordCheck("cpu_support", "unverified", components,
        `AMD doesn't list ${cpuName} as supported on ${chipset}, though some boards support it anyway: check the board's CPU support list before buying.`);
      return;
    }
    if (cell === "beta") {
      recordCheck("cpu_support", "unverified", components,
        `${identity.series} support on ${chipset} boards depends on the board maker releasing a BIOS for it: check the board's CPU support list for ${cpuName} before buying.`);
      return;
    }
    if (identity.am4Refresh2024) {
      recordCheck("cpu_support", "unverified", components,
        `${cpuName} is a 2024 AM4 release and needs a recent BIOS. Check the ${chipset} board's CPU support list and update the BIOS before installing it.`);
      return;
    }
    // Ryzen 4000/5000 launched after 400-series boards, and 5000 after A520.
    if ((identity.series === "Ryzen 5000" && (family === "am4-400" || compact === "A520")) || (identity.series === "Ryzen 4000" && family === "am4-400")) {
      biosAdvisory(recordCheck, issues, components, chipset, cpuName, "a board still on its factory BIOS needs an update first, via BIOS Flashback or an older CPU");
      return;
    }
    recordCheck("cpu_support", "passed", components, `Chipset ${chipset} supports ${cpuName}.`);
    return;
  }

  if (identity.platform === "LGA1700" && family.startsWith("lga1700")) {
    const needsBios =
      (family === "lga1700-600" && (identity.series === "13th gen" || identity.series === "14th gen")) ||
      (family === "lga1700-700" && identity.series === "14th gen");
    if (needsBios) {
      biosAdvisory(recordCheck, issues, components, chipset, `${cpuName} (${identity.series})`, "update the BIOS with a supported CPU first, or use BIOS Flashback if the board has it");
      return;
    }
    recordCheck("cpu_support", "passed", components, `Chipset ${chipset} supports ${cpuName}.`);
    return;
  }

  if (identity.platform === "AM5" && family === "am4-500") return;
  if (identity.platform === "LGA1851" && family === "lga1851-800") {
    recordCheck("cpu_support", "passed", components, `Chipset ${chipset} supports ${cpuName}.`);
    return;
  }

  // Cross-platform pairings (AM4 CPU on an AM5 board, etc.) already fail the
  // socket rule; anything else unrecognized stays silent.
}
