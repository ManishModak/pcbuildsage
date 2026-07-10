import { z } from "zod";
import { badRequest, json, readJson } from "../_lib/responses";
import { encodeSse, sseHeaders } from "../_lib/sse";
import { downloadSeed } from "@/lib/seed-download-helper";
import { DEFAULT_DB_PATH } from "@/lib/db";

export const runtime = "nodejs";

const seedSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/)
});

// Module-level in-flight lock: prevents concurrent POSTs from running
// downloadSeed against the same database file simultaneously.
const inFlightSeeds = new Set<string>();

export async function POST(request: Request): Promise<Response> {
  try {
    const body = seedSchema.parse(await readJson(request));

    if (inFlightSeeds.has(DEFAULT_DB_PATH)) {
      return json({ error: "seed_in_progress" }, { status: 409 });
    }
    inFlightSeeds.add(DEFAULT_DB_PATH);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encodeSse("started", { country: body.country }));
        try {
          await downloadSeed(body.country, {
            dbPath: DEFAULT_DB_PATH,
            onProgress(percent, message) {
              controller.enqueue(
                encodeSse("progress", {
                  country: body.country,
                  percent,
                  status: "downloading",
                  message
                })
              );
            }
          });
          controller.enqueue(encodeSse("done", { country: body.country, available: true }));
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          controller.enqueue(encodeSse("progress", {
            country: body.country,
            percent: 0,
            status: "failed",
            message: errMsg
          }));
          controller.enqueue(encodeSse("error", { error: errMsg }));
        } finally {
          inFlightSeeds.delete(DEFAULT_DB_PATH);
          controller.close();
        }
      }
    });
    return new Response(stream, { headers: sseHeaders() });
  } catch (error) {
    return badRequest(error);
  }
}
