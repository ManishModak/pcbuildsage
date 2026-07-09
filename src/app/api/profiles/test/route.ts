import { z } from "zod";
import { buildTestProfileArgs, resolvePython, spawnScraper } from "../../_lib/python";
import { badRequest, json, readJson, serverError } from "../../_lib/responses";

export const runtime = "nodejs";

const testProfileSchema = z.object({
  profile: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  site: z.string().optional(),
  categories: z.array(z.string()).optional(),
  headed: z.boolean().optional(),
  delayMs: z.number().int().min(0).optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = testProfileSchema.parse(await readJson(request));
    const resolution = await resolvePython();
    if (!resolution.ok) return json({ error: "python_unavailable", python: resolution }, { status: 503 });
    const result = await runChild(resolution, buildTestProfileArgs(body));
    return json({
      ok: result.code === 0,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      hitRates: parseHitRates(result.stdout)
    }, { status: result.code === 0 ? 200 : 500 });
  } catch (error) {
    if (error instanceof z.ZodError) return badRequest(error);
    return serverError(error);
  }
}

function runChild(resolution: Awaited<ReturnType<typeof resolvePython>>, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnScraper(resolution, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseHitRates(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => ({ line }));
}
