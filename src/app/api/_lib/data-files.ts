import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function readJsonFiles<T extends Record<string, unknown>>(dir: string): Array<T & { id: string }> {
  const resolvedDir = path.resolve(dir);
  return readdirSync(resolvedDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      id: file.replace(/\.json$/, ""),
      ...(JSON.parse(readFileSync(path.join(resolvedDir, file), "utf8")) as T)
    }));
}

export function listProfiles(dir = path.join(process.cwd(), "data", "profiles")) {
  return readJsonFiles<{
    profile_name?: string;
    country_code?: string;
    default_currency?: string;
    sites?: Array<{ site_name?: string; categories?: Record<string, unknown> }>;
  }>(dir).map((profile) => {
    const filePath = path.join(dir, `${profile.id}.json`);
    const sites = profile.sites ?? [];
    return {
      id: profile.id,
      profileName: profile.profile_name,
      countryCode: profile.country_code,
      flag: countryFlag(profile.country_code),
      currency: profile.default_currency,
      siteCount: sites.length,
      sites: sites.map((site) => ({
        name: site.site_name,
        categories: Object.keys(site.categories ?? {})
      })),
      lastValidated: statSync(filePath).mtime.toISOString()
    };
  });
}

function countryFlag(countryCode: string | undefined): string | undefined {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return undefined;
  return [...countryCode].map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65)).join("");
}

