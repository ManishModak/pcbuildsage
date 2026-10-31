/**
 * src/lib/spec-canonical.ts
 *
 * Dependency-neutral canonicalizers shared by catalog filtering and
 * compatibility validation. Pure string functions with no database, registry,
 * or framework imports, so both layers can use them without a layering cycle.
 *
 * Alias contract (form factors):
 * - Distinct physical standards are never merged: ATX != E-ATX, DTX != Mini-DTX,
 *   SFX != SFX-L.
 * - Known shorthands map to their canonical standard: mATX/uATX/Micro-ATX map to
 *   micro-atx, mITX/Mini-ITX map to mini-itx, E-ATX/Extended ATX maps to e-atx.
 * - Bare "ITX" is intentionally NOT claimed as Mini-ITX: it names the ITX family
 *   (Mini/Nano/Pico-ITX), so it canonicalizes to "itx" and only matches a
 *   literal ITX spec.
 */
export function canonicalizeSocket(socket: unknown): string {
  if (typeof socket !== "string") return "";
  return socket.trim().toLowerCase().replace(/[\s-_]+/g, "");
}

export function canonicalizeFormFactor(formFactor: unknown): string {
  if (typeof formFactor !== "string") return "";
  const cleaned = formFactor.trim().toLowerCase().replace(/[\s-_]+/g, "");
  switch (cleaned) {
    case "matx":
    case "microatx":
    case "uatx":
      return "micro-atx";
    case "mitx":
    case "miniitx":
      return "mini-itx";
    case "eatx":
    case "extendedatx":
      return "e-atx";
    case "xlatx":
      return "xl-atx";
    case "dtx":
      return "dtx";
    case "minidtx":
      return "mini-dtx";
    case "atx":
      return "atx";
    case "ssieeb":
      return "ssi-eeb";
    case "ssiceb":
      return "ssi-ceb";
    case "sfx":
      return "sfx";
    case "sfxl":
      return "sfx-l";
    default:
      return cleaned;
  }
}

/**
 * Plain compacting for memory generations and storage interfaces ("DDR4", "nvme").
 * Deliberately alias-free: unlike sockets and form factors these tokens have no
 * shorthand families, so both consumers share this instead of a generic helper.
 */
export function canonicalizeMemory(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
