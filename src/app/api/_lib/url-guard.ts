import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function assertSafeFetchUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Profile import URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Profile import URL must not include embedded credentials.");
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(hostname)) {
    throw new UnsafeUrlError("Profile import URL host is not allowed.");
  }

  return url;
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const version = isIP(hostname);
  if (version === 4) return isBlockedIpv4(hostname);
  if (version === 6) return isBlockedIpv6(hostname);
  return false;
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const bytes = ipv6Bytes(hostname);
  if (!bytes) return true;
  if (bytes.every((byte, index) => byte === (index === bytes.length - 1 ? 1 : 0))) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

  const mappedIpv4 = ipv4FromMappedIpv6(bytes);
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false;
}

function ipv6Bytes(hostname: string): number[] | undefined {
  const ipv4Match = hostname.match(/(.+:)(\d+\.\d+\.\d+\.\d+)$/);
  let source = hostname;
  if (ipv4Match) {
    const octets = ipv4Match[2].split(".").map(Number);
    source = `${ipv4Match[1]}${((octets[0] << 8) + octets[1]).toString(16)}:${((octets[2] << 8) + octets[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Groups(halves[0]);
  const right = parseIpv6Groups(halves[1] ?? "");
  if (!left || !right) return undefined;

  let groups: number[];
  if (halves.length === 2) {
    const zeros = 8 - left.length - right.length;
    if (zeros < 0) return undefined;
    groups = [...left, ...Array(zeros).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return undefined;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function parseIpv6Groups(source: string): number[] | undefined {
  if (!source) return [];
  const groups = source.split(":").map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return Number.NaN;
    return Number.parseInt(part, 16);
  });
  return groups.some((value) => Number.isNaN(value)) ? undefined : groups;
}

function ipv4FromMappedIpv6(bytes: number[]): string | undefined {
  const isMapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (!isMapped) return undefined;
  return bytes.slice(12).join(".");
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
