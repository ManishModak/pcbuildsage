import type { RegistrySpec } from "@/lib/registry";
import {
  canonicalizeFormFactor,
  canonicalizeMemory,
  canonicalizeSocket,
} from "@/lib/spec-canonical";

export { canonicalizeFormFactor, canonicalizeSocket };

/**
 * Checks whether a component spec matches the requested socket.
 * Supports scalar spec.socket (CPUs, motherboards) and array spec.sockets (coolers).
 * Blank input (including whitespace-only) is a no-op filter.
 */
export function matchesSocket(spec: RegistrySpec | undefined, inputSocket: string): boolean {
  if (!inputSocket) return true;
  const target = canonicalizeSocket(inputSocket);
  if (!target) return true;
  const sockets = [
    spec?.socket,
    ...(Array.isArray(spec?.sockets) ? spec.sockets : [])
  ].filter(Boolean).map(canonicalizeSocket);
  return sockets.includes(target);
}

/**
 * Checks whether a component spec matches the requested form factor.
 * Supports scalar spec.form_factor and array spec.form_factors with alias canonicalization.
 * Blank input (including whitespace-only) is a no-op filter.
 */
export function matchesFormFactor(spec: RegistrySpec | undefined, inputFormFactor: string): boolean {
  if (!inputFormFactor) return true;
  const target = canonicalizeFormFactor(inputFormFactor);
  if (!target) return true;
  const forms = [
    spec?.form_factor,
    ...(Array.isArray(spec?.form_factors) ? spec.form_factors : [])
  ].filter(Boolean).map(canonicalizeFormFactor);
  return forms.includes(target);
}

/**
 * Checks whether a component spec matches the requested memory generation.
 * Supports scalar spec.ddr (boards, RAM) and array spec.supported_memory (CPUs).
 * A spec with no memory facts cannot satisfy an explicit generation filter.
 * Blank input (including whitespace-only) is a no-op filter.
 */
export function matchesDdr(spec: RegistrySpec | undefined, inputDdr: string): boolean {
  if (!inputDdr) return true;
  const target = canonicalizeMemory(inputDdr);
  if (!target) return true;
  const supported = [
    spec?.ddr,
    ...(Array.isArray(spec?.supported_memory) ? spec.supported_memory : [])
  ].filter(Boolean).map(canonicalizeMemory);
  if (supported.length > 0) return supported.includes(target);
  return false;
}

/**
 * Resolves the RAM stick count for a listing, mirroring the patterns in
 * isSingleModuleRam (src/lib/rules/shared.ts): an explicit registry `modules`
 * number wins, otherwise the retail title is parsed for kit notation such as
 * "2x8GB" or "kit of 2". Returns undefined when neither source states a count.
 */
export function resolveRamModules(
  spec: RegistrySpec | undefined,
  productName?: string,
  registryKey?: string
): number | undefined {
  const rawModules = spec?.modules;
  if (typeof rawModules === "number" && Number.isFinite(rawModules) && rawModules > 0) {
    return Math.floor(rawModules);
  }
  if (typeof rawModules === "string" && rawModules.trim().length > 0) {
    const parsed = Number(rawModules.trim());
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const haystack = [registryKey ?? "", typeof spec?.model === "string" ? spec.model : "", productName ?? ""].join(" ");
  const kitMatch = haystack.match(/(\d+)\s*x\s*\d+\s*gb/i) ?? haystack.match(/kit of (\d+)/i);
  if (kitMatch) {
    const count = Number.parseInt(kitMatch[1], 10);
    if (Number.isInteger(count) && count > 0) return count;
  }
  if (/\bdual[-\s]?channel\b/i.test(haystack)) return 2;
  if (/\bsingle[-\s]?(stick|channel)\b/i.test(haystack)) return 1;
  return undefined;
}

/**
 * Checks whether a RAM listing matches the requested stick count (e.g.
 * modules: 2 for dual-channel kits). A listing whose stick count cannot be
 * determined cannot satisfy an explicit filter. Blank input is a no-op.
 */
export function matchesModules(
  spec: RegistrySpec | undefined,
  inputModules: number | undefined,
  productName?: string,
  registryKey?: string
): boolean {
  if (inputModules === undefined) return true;
  return resolveRamModules(spec, productName, registryKey) === inputModules;
}
