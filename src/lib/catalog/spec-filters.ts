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
