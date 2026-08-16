import { z } from "zod";
import { badRequest, InvalidJsonError, json, readJson, serverError } from "../../_lib/responses";
import { buildTestProfileArgs, resolvePython, runPythonCaptured } from "@/lib/server/python-process";

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
    const result = await runPythonCaptured(resolution, buildTestProfileArgs(body), {
      signal: request.signal,
      timeoutMs: 60_000,
      maxOutputBytes: 1_000_000
    });
    return json({
      ok: result.code === 0,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      hitRates: parseHitRates(result.stdout)
    }, { status: result.code === 0 ? 200 : 500 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof InvalidJsonError) return badRequest(error);
    return serverError(error);
  }
}

function parseHitRates(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => ({ line }));
}
