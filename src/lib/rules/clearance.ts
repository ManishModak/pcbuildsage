/**
 * src/lib/rules/clearance.ts
 *
 * Physical-fit checks: GPU length, cooler fit (tower height or radiator mount),
 * motherboard form factor, and PSU form factor against case limits.
 * Also owns the cooler TDP/socket-bracket check, so all cooler logic lives here.
 */
import { canonicalizeFormFactor, canonicalizeSocket } from "../spec-canonical";
import type { ResolvedSpec } from "../registry";
import type { BuildIssue } from "../rules-engine";
import {
  arraySpec,
  confidenceGate,
  isStockCooler,
  lowNames,
  needsResearch,
  numberSpec,
  stringSpec,
  trustedNumber,
  untrusted,
  type CheckRecorder,
} from "./shared";

export type CoolerForm = "aio" | "air" | "unknown";

/**
 * Explicit cooler construction only. Model-name guessing was removed: an
 * untyped cooler stays "unknown" and its fit stays unverified rather than
 * passing on a height number that may describe a pump block, not a tower.
 */
export function coolerForm(cooler: ResolvedSpec, issues?: BuildIssue[]): CoolerForm {
  if (cooler.spec.cooler_type === "aio" || typeof cooler.spec.radiator_size_mm === "number") return "aio";
  if (cooler.spec.cooler_type === "air" || isStockCooler(cooler)) return "air";
  if (issues) {
    issues.push(needsResearch([cooler.key], `${cooler.key} cooler construction is unknown. Research cooler_type with consult before clearance can be verified.`));
  }
  return "unknown";
}

export function isAioCooler(cooler: ResolvedSpec): boolean {
  return coolerForm(cooler) === "aio";
}

export function inferRadiatorSize(cooler: ResolvedSpec): number | undefined {
  // Model numbers and fan dimensions do not establish radiator size.
  // The clearance check separately verifies the source's confidence.
  const size = cooler.spec.radiator_size_mm;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : undefined;
}

export function checkClearance(
  gpu: ResolvedSpec | undefined,
  pcCase: ResolvedSpec | undefined,
  cooler: ResolvedSpec | undefined,
  motherboard: ResolvedSpec | undefined,
  psu: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  checkGpuFit(gpu, pcCase, recordCheck, issues);
  checkCoolerFit(cooler, pcCase, recordCheck, issues);
  checkBoardFit(motherboard, pcCase, recordCheck, issues);
  checkPsuFit(psu, pcCase, recordCheck, issues);
}

function checkGpuFit(
  gpu: ResolvedSpec | undefined,
  pcCase: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!gpu || !pcCase) return;
  const hasLengthConflict =
    typeof gpu.spec.spec_conflict === "string" &&
    /length|dimension/i.test(gpu.spec.spec_conflict);
  if (hasLengthConflict) {
    const msg = "GPU fit couldn’t be verified due to conflicting length specs. Please check the card’s length against the case’s GPU clearance before buying.";
    recordCheck("clearance", "unverified", [gpu.key, pcCase.key], msg);
    return;
  }
  const gpuLength = trustedNumber(gpu, "length_mm", issues);
  const maxGpu = trustedNumber(pcCase, "max_gpu_length_mm", issues);
  if (gpuLength !== undefined && maxGpu !== undefined) {
    if (gpuLength <= maxGpu) {
      recordCheck(
        "clearance",
        "passed",
        [gpu.key, pcCase.key],
        `GPU length fits: ${gpuLength}mm card / ${maxGpu}mm case clearance.`
      );
      confidenceGate("clearance", [gpu, pcCase], issues, `GPU clearance pass uses low-confidence researched specs for ${lowNames([gpu, pcCase])}.`);
    } else {
      const msg = `GPU is ${gpuLength - maxGpu}mm too long for this case.`;
      recordCheck("clearance", "failed", [gpu.key, pcCase.key], msg);
    }
  } else {
    const msg = "GPU fit couldn’t be verified. Please check the card’s length against the case’s GPU clearance before buying.";
    recordCheck("clearance", "unverified", [gpu.key, pcCase.key], msg);
  }
}

function checkCoolerFit(
  cooler: ResolvedSpec | undefined,
  pcCase: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!cooler || !pcCase) return;
  const form = coolerForm(cooler, issues);
  if (form === "aio") {
    checkAioFit(cooler, pcCase, recordCheck, issues);
  } else if (form === "air") {
    checkAirFit(cooler, pcCase, recordCheck, issues);
  } else {
    recordCheck(
      "clearance",
      "unverified",
      [cooler.key, pcCase.key],
      "Cooler construction is unknown: tower height and radiator fit couldn’t be verified against case clearance."
    );
  }
}

function checkAioFit(
  cooler: ResolvedSpec,
  pcCase: ResolvedSpec,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  const radiatorSize = inferRadiatorSize(cooler);
  const supportedRadiators = Array.isArray(pcCase.spec.supported_radiators)
    ? pcCase.spec.supported_radiators.filter((r): r is number => typeof r === "number")
    : undefined;

  const trustedCooler = !untrusted(cooler, issues);
  const trustedCase = !untrusted(pcCase, issues);

  if (!trustedCooler || !trustedCase) {
    recordCheck(
      "clearance",
      "unverified",
      [cooler.key, pcCase.key],
      `Radiator clearance fit couldn’t be verified due to low-confidence or untrusted specs for ${lowNames([cooler, pcCase])}.`
    );
  } else if (radiatorSize !== undefined && supportedRadiators !== undefined) {
    const maxSupportedRadiator = supportedRadiators.length > 0
      ? Math.max(...supportedRadiators)
      : 0;

    if (supportedRadiators.includes(radiatorSize)) {
      recordCheck(
        "clearance",
        "passed",
        [cooler.key, pcCase.key],
        `Radiator mount fits: ${radiatorSize}mm radiator is supported by case (${supportedRadiators.join(", ")}mm). Note: physical thickness and component clearances not verified.`
      );
      confidenceGate("clearance", [cooler, pcCase], issues, `Radiator clearance pass uses low-confidence researched specs for ${lowNames([cooler, pcCase])}.`);
    } else if (supportedRadiators.length === 0 || radiatorSize > maxSupportedRadiator) {
      const msg = `Radiator size ${radiatorSize}mm is not supported by case (exceeds max supported size${maxSupportedRadiator > 0 ? ` of ${maxSupportedRadiator}mm` : ""}; supported sizes: ${supportedRadiators.length ? supportedRadiators.join(", ") + "mm" : "none"}).`;
      recordCheck("clearance", "failed", [cooler.key, pcCase.key], msg);
    } else {
      const msg = `Radiator size ${radiatorSize}mm fit couldn’t be verified against case (supported sizes: ${supportedRadiators.join(", ")}mm). Please check manufacturer mounting specs before buying.`;
      recordCheck("clearance", "unverified", [cooler.key, pcCase.key], msg);
    }
  } else {
    const reason = radiatorSize === undefined
      ? "AIO radiator nominal size is unknown."
      : "Case supported radiator sizes are not specified.";
    recordCheck(
      "clearance",
      "unverified",
      [cooler.key, pcCase.key],
      `Radiator clearance couldn’t be verified: ${reason}`
    );
  }
}

function checkAirFit(
  cooler: ResolvedSpec,
  pcCase: ResolvedSpec,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  const height = trustedNumber(cooler, "height_mm", issues);
  const maxHeight = trustedNumber(pcCase, "max_cooler_height_mm", issues);
  if (height !== undefined && maxHeight !== undefined) {
    if (height <= maxHeight) {
      recordCheck(
        "clearance",
        "passed",
        [cooler.key, pcCase.key],
        `Cooler height fits: ${height}mm cooler / ${maxHeight}mm case clearance.`
      );
      confidenceGate("clearance", [cooler, pcCase], issues, `Cooler clearance pass uses low-confidence researched specs for ${lowNames([cooler, pcCase])}.`);
    } else {
      const msg = `Cooler height ${height}mm exceeds case clearance ${maxHeight}mm.`;
      recordCheck("clearance", "failed", [cooler.key, pcCase.key], msg);
    }
  } else {
    const msg = "Cooler height fit couldn’t be verified against case clearance.";
    recordCheck("clearance", "unverified", [cooler.key, pcCase.key], msg);
  }
}

function checkBoardFit(
  motherboard: ResolvedSpec | undefined,
  pcCase: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!motherboard || !pcCase) return;
  const formFactor = typeof motherboard.spec.form_factor === "string" ? motherboard.spec.form_factor : undefined;
  const supported = Array.isArray(pcCase.spec.form_factors) ? pcCase.spec.form_factors : undefined;
  const trustedBoard = !untrusted(motherboard, issues);
  const trustedCase = !untrusted(pcCase, issues);

  if (formFactor && supported && trustedBoard && trustedCase) {
    if (supported.map(canonicalizeFormFactor).includes(canonicalizeFormFactor(formFactor))) {
      recordCheck(
        "clearance",
        "passed",
        [motherboard.key, pcCase.key],
        `Motherboard form factor ${formFactor} fits case.`
      );
      confidenceGate("clearance", [motherboard, pcCase], issues, `Form-factor pass uses low-confidence researched specs for ${lowNames([motherboard, pcCase])}.`);
    } else {
      const msg = `Motherboard ${formFactor} is not supported by the case.`;
      recordCheck("clearance", "failed", [motherboard.key, pcCase.key], msg);
    }
  } else {
    const msg = "Motherboard form factor fit couldn’t be verified against case.";
    recordCheck("clearance", "unverified", [motherboard.key, pcCase.key], msg);
  }
}

function checkPsuFit(
  psu: ResolvedSpec | undefined,
  pcCase: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!psu || !pcCase) return;
  const psuFf = typeof psu.spec.form_factor === "string" ? psu.spec.form_factor : undefined;
  const supportedPsu = Array.isArray(pcCase.spec.supported_psu_form_factors)
    ? pcCase.spec.supported_psu_form_factors.filter((f): f is string => typeof f === "string")
    : undefined;

  const trustedPsu = !untrusted(psu, issues);
  const trustedCase = !untrusted(pcCase, issues);

  if (supportedPsu !== undefined && psuFf !== undefined) {
    if (!trustedPsu || !trustedCase) {
      recordCheck(
        "clearance",
        "unverified",
        [psu.key, pcCase.key],
        `PSU form factor fit couldn’t be verified due to low-confidence specs for ${lowNames([psu, pcCase])}.`
      );
    } else if (supportedPsu.map(canonicalizeFormFactor).includes(canonicalizeFormFactor(psuFf))) {
      recordCheck(
        "clearance",
        "passed",
        [psu.key, pcCase.key],
        `PSU form factor ${psuFf} fits case (supported: ${supportedPsu.join(", ")}).`
      );
      confidenceGate("clearance", [psu, pcCase], issues, `PSU form factor pass uses low-confidence specs for ${lowNames([psu, pcCase])}.`);
    } else {
      const msg = `PSU form factor ${psuFf} is not supported by case (supported: ${supportedPsu.join(", ")}).`;
      recordCheck("clearance", "failed", [psu.key, pcCase.key], msg);
    }
  } else {
    const msg = "PSU form factor fit couldn’t be verified against case.";
    recordCheck("clearance", "unverified", [psu.key, pcCase.key], msg);
  }
}

export function checkCooler(
  cpu: ResolvedSpec | undefined,
  cooler: ResolvedSpec | undefined,
  recordCheck: CheckRecorder,
  issues: BuildIssue[]
) {
  if (!cpu || !cooler) return;
  if (cooler.key === "included-stock-cooler") {
    recordCheck(
      "cooler",
      "unverified",
      [cpu.key, cooler.key],
      "Cooler compatibility couldn't be verified due to missing specs."
    );
    return;
  }
  const cpuTdp = numberSpec(cpu, "tdp_w", issues);
  const rating = numberSpec(cooler, "tdp_rating_w", issues);
  const socket = stringSpec(cpu, "socket", issues);
  const sockets = arraySpec(cooler, "sockets", issues);
  if (cpuTdp === undefined || rating === undefined || !socket || !sockets) {
    recordCheck(
      "cooler",
      "unverified",
      [cpu.key, cooler.key],
      "Cooler compatibility couldn't be verified due to missing specs."
    );
    return;
  }
  if (rating < cpuTdp) {
    const msg = isStockCooler(cooler)
      ? `Stock cooler rating (${rating}W) is below CPU ${cpuTdp}W TDP.`
      : `Cooler ${rating}W rating is below CPU ${cpuTdp}W TDP.`;
    recordCheck("cooler", "failed", [cpu.key, cooler.key], msg);
    return;
  }
  if (!sockets.map(canonicalizeSocket).includes(canonicalizeSocket(socket))) {
    const msg = `Cooler does not list a ${socket} mounting bracket.`;
    recordCheck("cooler", "failed", [cpu.key, cooler.key], msg);
    return;
  }
  const msg = isStockCooler(cooler)
    ? `Stock cooler is suitable for ${cpu.key} (${cpuTdp}W TDP).`
    : `Cooler rating (${rating}W) and socket (${socket}) match CPU (${cpuTdp}W).`;
  recordCheck("cooler", "passed", [cpu.key, cooler.key], msg);
  confidenceGate("cooler", [cpu, cooler], issues, `Cooler pass uses low-confidence researched specs for ${lowNames([cpu, cooler])}.`);
}
