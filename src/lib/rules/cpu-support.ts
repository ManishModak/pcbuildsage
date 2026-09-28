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
 * - Ryzen 5000 on 300-series boards (A320/B350/X370) depends on whether the
 *   board maker shipped a BIOS for it, so it is unverified with a "check the
 *   CPU support list" message, never blocking. (GIGABYTE's statement that its
 *   A320 boards don't support the Ryzen 5 5500, press/news/1978, could not be
 *   re-fetched, so it isn't used as a blocking source.)
 * - B550/A520 boards do not support pre-Zen 3 CPUs (Ryzen 1000/2000 series and
 *   Ryzen 2000G/3000G APUs with Radeon Graphics): AMD's official AM4 chipset
 *   specifications matrix (https://www.amd.com/en/products/processors/chipsets/am4.html,
 *   verified 2026-09-28) explicitly marks B550 and A520 as incompatible ("X")
 *   with Athlon with Radeon Graphics, Ryzen 1000, Ryzen 2000 (standard and graphics),
 *   and Ryzen 3000 with Radeon Graphics, starting support at Ryzen 3000 (standard non-G),
 *   Ryzen 4000, and Ryzen 5000. Confirmed also by AMD press releases (June 16, 2020:
 *   https://ir.amd.com/news-events/press-releases/detail/955/amd-offers-enthusiasts-more-choice-than-ever-before-with-new-ryzen-3000xt-processors ;
 *   April 21, 2020: https://ir.amd.com/news-events/press-releases/detail/942/amd-expands-3rd-gen-amd-ryzen-desktop-processor-family-unleashing-powerful-zen-2-core-for-the-mainstream).
 *
 * Anything the rule cannot identify (unknown chipset, unparseable CPU
 * generation, cross-platform pairing) is left to the socket rule - this rule
 * stays silent rather than guessing.
 */
import type { ResolvedSpec } from "../registry";
import type { BuildIssue } from "../rules-engine";
import { untrusted, type CheckRecorder } from "./shared";

// AMD AM4 chipset specifications (https://www.amd.com/en/products/processors/chipsets/am4.html, verified 2026-09-28)
// confirm B550 and A520 do not support Ryzen 1000, 2000, or 3000G/2000G APUs.
const B550_A520_PRE_ZEN3_STATUS: "failed" | "unverified" = "failed";

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
    if (seriesDigit >= "1" && seriesDigit <= "3") return { platform: "AM4", series: `Ryzen ${series}`, apu };
  }

  return undefined;
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
    const preZen3 = identity.series === "Ryzen 1000" || identity.series === "Ryzen 2000" || (identity.series === "Ryzen 3000" && identity.apu);
    if (preZen3 && (compact === "B550" || compact === "A520")) {
      recordCheck("cpu_support", B550_A520_PRE_ZEN3_STATUS, components,
        `${chipset} boards don't support ${cpuName}: AMD's 500-series chipsets start at Ryzen 3000 (non-G). Pick a Ryzen 3000 (non-G), 4000 or 5000 CPU instead.`);
      return;
    }
    if (identity.series === "Ryzen 5000" && family === "am4-300") {
      recordCheck("cpu_support", "unverified", components,
        `Ryzen 5000 support on ${chipset} boards depends on the board maker releasing a BIOS for it: check the board's CPU support list for ${cpuName} before buying.`);
      return;
    }
    if (identity.am4Refresh2024) {
      recordCheck("cpu_support", "unverified", components,
        `${cpuName} is a 2024 AM4 release and needs a recent BIOS. Check the ${chipset} board's CPU support list and update the BIOS before installing it.`);
      return;
    }
    if (identity.series === "Ryzen 5000" && (family === "am4-400" || compact === "A520")) {
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
