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
 * - GIGABYTE states A320 boards do not support the Ryzen 5 5500 due to an
 *   AMD BIOS code limitation
 *   (https://www.gigabyte.com/press/news/1978): blocking.
 *
 * Anything the rule cannot identify (unknown chipset, unparseable CPU
 * generation, cross-platform pairing) is left to the socket rule - this rule
 * stays silent rather than guessing.
 */
import type { ResolvedSpec } from "../registry";
import type { BuildIssue } from "../rules-engine";
import { untrusted, type CheckRecorder } from "./shared";

type CpuPlatform = "AM4" | "AM5" | "LGA1700" | "LGA1851";

type CpuIdentity = { platform: CpuPlatform; series: string };

/**
 * CPU platform + generation read deterministically off the model name,
 * e.g. i9-14900K -> LGA1700/14th gen, Ryzen 5 5600 -> AM4/Ryzen 5000,
 * Core Ultra 7 265K -> LGA1851. Returns undefined when the name does not
 * state a recognizable desktop CPU.
 */
export function inferCpuIdentity(cpu: ResolvedSpec): CpuIdentity | undefined {
  const text = `${cpu.spec.brand ?? ""} ${cpu.spec.model ?? ""} ${cpu.key}`;

  const ultra = text.match(/\bultra\s*[957]\s*(2)\d{2}\b/i);
  if (ultra) return { platform: "LGA1851", series: "Series 2" };

  const intel = text.match(/\bi[\s\-]?[3579][\-\s]?(\d{2})\d{2,3}[a-z]*\b/i);
  if (intel) {
    const gen = intel[1];
    if (gen === "12" || gen === "13" || gen === "14") {
      return { platform: "LGA1700", series: `${gen}th gen` };
    }
    return undefined;
  }

  const ryzen = text.match(/\bryzen[\s\-]*(?:\d[\s\-]*)?(\d)(\d{3})(?![0-9])/i);
  if (ryzen) {
    const seriesDigit = ryzen[1];
    const series = `${seriesDigit}000`;
    if (seriesDigit >= "7") return { platform: "AM5", series: `Ryzen ${series}` };
    if (seriesDigit === "5") {
      // Desktop Ryzen 5000 (incl. 5500/5600/5700X/5800X3D) is AM4.
      return { platform: "AM4", series: `Ryzen ${series}` };
    }
    if (seriesDigit >= "1" && seriesDigit <= "3") return { platform: "AM4", series: `Ryzen ${series}` };
  }

  return undefined;
}

type ChipsetFamily = "am4-300" | "am4-400" | "am4-500" | "lga1700-600" | "lga1700-700" | "lga1851-800";

function chipsetFamily(chipset: string): ChipsetFamily | undefined {
  const compact = chipset.toUpperCase().replace(/[\s\-_]/g, "");
  if (/^(X370|B350|A320)$/.test(compact)) return "am4-300";
  if (/^(X470|B450)$/.test(compact)) return "am4-400";
  if (/^(X570|B550|A520)$/.test(compact)) return "am4-500";
  if (/^(Z690|H670|B660|H610)$/.test(compact)) return "lga1700-600";
  if (/^(Z790|H770|B760)$/.test(compact)) return "lga1700-700";
  if (/^(Z890|B860|H810)$/.test(compact)) return "lga1851-800";
  return undefined;
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
  const family = chipsetFamily(chipset);
  const identity = inferCpuIdentity(cpu);
  if (!family || !identity) return;

  const components = [cpu.key, motherboard.key];

  if (identity.platform === "AM4" && family.startsWith("am4")) {
    // GIGABYTE documents A320 as not supporting the Ryzen 5 5500 (AMD BIOS
    // code limitation): the CPU will not boot on that board.
    if (family === "am4-300" && /^a320$/i.test(chipset.replace(/[\s\-_]/g, "")) && /\bryzen[\s\-]*5[\s\-]*5500(?![0-9])/i.test(`${cpu.spec.model ?? ""} ${cpu.key}`)) {
      recordCheck(
        "cpu_support",
        "failed",
        components,
        "The Ryzen 5 5500 is not supported on A320 boards (AMD BIOS code limitation); it will not boot on this motherboard."
      );
      return;
    }
    if (identity.series === "Ryzen 5000" && (family === "am4-400" || chipset.toUpperCase().replace(/[\s\-_]/g, "") === "A520")) {
      recordCheck(
        "cpu_support",
        "unverified",
        components,
        `This ${chipset} board predates Ryzen 5000 and needs a BIOS update (AGESA ComboAM4v2 or newer) before a ${cpu.spec.model || cpu.key} will boot. Update with an older compatible CPU first, or use BIOS Flashback if the board supports it.`
      );
      return;
    }
    recordCheck(
      "cpu_support",
      "passed",
      components,
      `Chipset ${chipset} supports ${cpu.spec.model || cpu.key}.`
    );
    return;
  }

  if (identity.platform === "LGA1700" && family.startsWith("lga1700")) {
    const needsBios =
      (family === "lga1700-600" && (identity.series === "13th gen" || identity.series === "14th gen")) ||
      (family === "lga1700-700" && identity.series === "14th gen");
    if (needsBios) {
      recordCheck(
        "cpu_support",
        "unverified",
        components,
        `This ${chipset} board may need a BIOS update before a ${cpu.spec.model || cpu.key} (${identity.series}) will boot. Intel requires a BIOS update on 600/700-series boards for 13th/14th gen CPUs - update with a supported CPU first, or use BIOS Flashback if the board supports it.`
      );
      return;
    }
    recordCheck(
      "cpu_support",
      "passed",
      components,
      `Chipset ${chipset} supports ${cpu.spec.model || cpu.key}.`
    );
    return;
  }

  if (identity.platform === "AM5" && family === "am4-500") return;
  if (identity.platform === "LGA1851" && family === "lga1851-800") {
    recordCheck(
      "cpu_support",
      "passed",
      components,
      `Chipset ${chipset} supports ${cpu.spec.model || cpu.key}.`
    );
    return;
  }

  // Cross-platform pairings (AM4 CPU on an AM5 board, etc.) already fail the
  // socket rule; anything else unrecognized stays silent.
}
