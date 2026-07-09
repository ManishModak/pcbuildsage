import { z } from "zod";
import { badRequest, readJson } from "../_lib/responses";
import { encodeSse, sseHeaders } from "../_lib/sse";

export const runtime = "nodejs";

const seedSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/)
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = seedSchema.parse(await readJson(request));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeSse("started", { country: body.country }));
        controller.enqueue(encodeSse("progress", {
          country: body.country,
          percent: 0,
          status: "not_yet_available",
          message: "Seed download script is planned for Plan 7; API bridge stub is active."
        }));
        controller.enqueue(encodeSse("done", { country: body.country, available: false }));
        controller.close();
      }
    });
    return new Response(stream, { headers: sseHeaders() });
  } catch (error) {
    return badRequest(error);
  }
}

