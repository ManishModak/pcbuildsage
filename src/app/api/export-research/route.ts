import { z } from "zod";
import { exportResearch } from "../../../lib/export-research";
import { resolveSandboxedPath } from "../_lib/paths";
import { badRequest, json, readJson, serverError } from "../_lib/responses";

export const runtime = "nodejs";

const exportSchema = z.object({
  dbPath: z.string().optional(),
  outputDir: z.string().optional()
}).optional();

export async function POST(request: Request): Promise<Response> {
  try {
    const body = exportSchema.parse(await readJson(request).catch(() => ({})));
    return json({ files: exportResearch(sandboxExportOptions(body ?? {})) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.name === "SandboxedPathError") return badRequest(error);
    return serverError(error);
  }
}

function sandboxExportOptions(options: z.infer<typeof exportSchema>) {
  return {
    dbPath: options?.dbPath ? resolveSandboxedPath(options.dbPath) : undefined,
    outputDir: options?.outputDir ? resolveSandboxedPath(options.outputDir) : undefined
  };
}
