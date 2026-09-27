/**
 * src/lib/rules/ddr.ts
 *
 * Memory-generation compatibility: CPU-supported generations against the
 * motherboard, and RAM against the motherboard (and transitively the CPU).
 */
import { canonicalizeMemory } from "../spec-canonical";
import type { ResolvedSpec } from "../registry";
import type { BuildIssue, BuildPart, BuildParts } from "../rules-engine";
import {
  confidenceGate,
  isSingleModuleRam,
  label,
  lowNames,
  stringSpec,
  untrusted,
  type CheckRecorder,
} from "./shared";

function getCpuSupportedMemory(cpu: ResolvedSpec, issues: BuildIssue[]): string[] | undefined {
  if (untrusted(cpu, issues)) return undefined;
  if (Array.isArray(cpu.spec.supported_memory) && cpu.spec.supported_memory.length > 0) {
    const valid = cpu.spec.supported_memory.filter((m): m is string => typeof m === "string" && m.length > 0);
    if (valid.length > 0) return valid;
  }
  const single = stringSpec(cpu, "ddr", issues);
  return single ? [single] : undefined;
}

export function checkDdr(
  cpu: ResolvedSpec | undefined,
  motherboard: ResolvedSpec | undefined,
  ram: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[],
  parts?: BuildParts
) {
  if (!motherboard) return;
  const boardDdr = stringSpec(motherboard, "ddr", issues);
  if (!boardDdr) {
    recordCheck(
      "ddr",
      "unverified",
      [motherboard.key, ...(cpu ? [cpu.key] : [])],
      "DDR compatibility couldn't be verified due to missing specs."
    );
    return;
  }

  const cpuSupported = cpu ? getCpuSupportedMemory(cpu, issues) : undefined;
  const cpuDdrLabel = cpuSupported ? (cpuSupported.length === 1 ? cpuSupported[0] : cpuSupported.join(", ")) : undefined;
  const ramDdr = ram ? stringSpec(ram, "ddr", issues) : undefined;

  // If neither RAM nor CPU DDR is present, we do not have sufficient inputs to claim DDR compatibility
  if (!ram && (!cpu || !cpuSupported || cpuSupported.length === 0)) {
    if (parts?.ram || parts?.cpu) {
      const components = [
        motherboard.key,
        ...(parts.cpu ? [label(parts.cpu as BuildPart)] : []),
        ...(parts.ram ? [label(parts.ram as BuildPart)] : [])
      ];
      recordCheck(
        "ddr",
        "unverified",
        components,
        "DDR compatibility couldn't be verified due to missing CPU/RAM specs."
      );
    }
    return;
  }

  if (cpu && cpuSupported && cpuSupported.length > 0) {
    const boardMatch = cpuSupported.some((m) => canonicalizeMemory(m) === canonicalizeMemory(boardDdr));
    if (!boardMatch) {
      const msg = `CPU-supported memory ${cpuDdrLabel} does not match motherboard ${boardDdr}.`;
      recordCheck("ddr", "failed", [cpu.key, motherboard.key], msg);
      return;
    }
  }

  if (!ram) {
    if (cpu && cpuSupported && cpuSupported.length > 0) {
      recordCheck(
        "ddr",
        "passed",
        [cpu.key, motherboard.key],
        `CPU memory support (${cpuDdrLabel}) matches motherboard (${boardDdr}).`
      );
      confidenceGate("ddr", [cpu, motherboard], issues, `DDR match uses low-confidence researched specs for ${lowNames([cpu, motherboard])}.`);
      if (parts?.ram) {
        recordCheck("ddr", "unverified", [motherboard.key, label(parts.ram as BuildPart)], "RAM DDR specification could not be verified.");
      }
    }
    return;
  }

  if (!ramDdr) {
    recordCheck(
      "ddr",
      "unverified",
      [motherboard.key, ram.key, ...(cpu ? [cpu.key] : [])],
      "RAM DDR specification is missing."
    );
    return;
  }

  if (canonicalizeMemory(boardDdr) !== canonicalizeMemory(ramDdr)) {
    const msg = `RAM ${ramDdr} does not match motherboard ${boardDdr}.`;
    recordCheck("ddr", "failed", [motherboard.key, ram.key], msg);
    return;
  }

  // CPU-vs-RAM needs no separate comparison: reaching this point means the CPU
  // matches the board and the board equals the RAM, so the CPU matches the RAM
  // transitively under the same canonicalization.

  if (isSingleModuleRam(ram)) {
    issues.push({
      severity: "advisory",
      rule: "ddr",
      components: [ram.key],
      detail: `Single-channel RAM detected (${ram.spec.model || ram.key}). Dual-channel memory (e.g. 2×8GB or 2×16GB) is recommended for optimal bandwidth and gaming frame rates.`
    });
  }

  if (cpu && cpuSupported && cpuSupported.length > 0) {
    recordCheck(
      "ddr",
      "passed",
      [cpu.key, motherboard.key, ram.key],
      `RAM (${ramDdr}) matches motherboard and CPU memory support.`
    );
    confidenceGate("ddr", [cpu, motherboard, ram], issues, `DDR match uses low-confidence researched specs for ${lowNames([cpu, motherboard, ram])}.`);
  } else {
    recordCheck(
      "ddr",
      "passed",
      [motherboard.key, ram.key],
      `RAM (${ramDdr}) matches motherboard (${boardDdr}).`
    );
    confidenceGate("ddr", [motherboard, ram], issues, `DDR match uses low-confidence researched specs for ${lowNames([motherboard, ram])}.`);
    if (parts?.cpu) {
      recordCheck(
        "ddr",
        "unverified",
        [motherboard.key, label(parts.cpu as BuildPart)],
        "CPU memory support could not be verified from the available data."
      );
    }
  }
}
