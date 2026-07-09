import { z } from "zod";
import { validateBuild } from "../../../lib/rules-engine";
import { badRequest, json, readJson } from "../_lib/responses";

export const runtime = "nodejs";

const validateSchema = z.object({
  parts: z.record(z.string(), z.unknown())
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = validateSchema.parse(await readJson(request));
    return json(validateBuild(body.parts));
  } catch (error) {
    return badRequest(error);
  }
}
