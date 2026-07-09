import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export type ProfileImportResult =
  | { ok: true; filePath: string; id: string }
  | { ok: false; errors: unknown[] };

export function validateAndWriteProfile(profile: unknown, options: { filename?: string; profilesDir?: string } = {}): ProfileImportResult {
  const schemaPath = path.join(process.cwd(), "data", "schemas", "profile.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(profile)) return { ok: false, errors: validate.errors ?? [] };

  const data = profile as { profile_name?: string; country_code?: string };
  const id = safeProfileId(options.filename) ?? safeProfileId(data.country_code) ?? safeProfileId(data.profile_name) ?? "imported-profile";
  const profilesDir = options.profilesDir ?? path.join(process.cwd(), "data", "profiles");
  mkdirSync(profilesDir, { recursive: true });
  const filePath = path.join(profilesDir, `${id}.json`);
  writeFileSync(filePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return { ok: true, filePath, id };
}

function safeProfileId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const basename = path.basename(value, ".json");
  const id = basename.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || undefined;
}

