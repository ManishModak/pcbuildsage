import path from "node:path";
import { readJsonFiles } from "../_lib/data-files";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json({ themes: readJsonFiles(path.join(process.cwd(), "data", "themes")) });
}

