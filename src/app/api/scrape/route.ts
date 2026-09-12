import { z } from "zod";
import { resolveSandboxedPath } from "../_lib/paths";
import { badRequest, json, readJson } from "../_lib/responses";
import { encodeSse, sseHeaders } from "../_lib/sse";
import { failedRunOutcome, parseRunOutcome, resolveRunTermination, type RunOutcome } from "@/contracts/scrape";
import {
  buildScraperArgs,
  createProcessTerminator,
  resolvePython,
  spawnPython
} from "@/lib/server/python-process";
import { guardHostedRoute } from "@/lib/middleware/route-guard";

export const runtime = "nodejs";

const scrapeSchema = z.object({
  profile: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  sites: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  quick: z.boolean().optional(),
  maxPages: z.number().int().min(1).optional(),
  skipFresh: z.number().int().min(1).optional(),
  noLlmFallback: z.boolean().optional(),
  maxLlmCalls: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(1).optional(),
  delayMs: z.number().int().min(0).optional(),
  headed: z.boolean().optional(),
  db: z.string().optional()
});

type ActiveScrape = {
  id: string;
  startedAt: string;
  status: "starting" | "running" | "terminating";
  command: string;
};

let activeScrape: ActiveScrape | undefined;

export async function POST(request: Request): Promise<Response> {
  const blocked = guardHostedRoute(request);
  if (blocked) return blocked;

  if (activeScrape) {
    return json({ running: true, scrape: activeScrape }, { status: 409 });
  }
  // Reserve the slot synchronously: the awaits below would otherwise let a
  // concurrent POST pass the guard and spawn a second scraper.
  const id = crypto.randomUUID();
  activeScrape = { id, startedAt: new Date().toISOString(), status: "starting", command: "" };
  const release = () => {
    if (activeScrape?.id === id) activeScrape = undefined;
  };

  try {
    const body = scrapeSchema.parse(await readJson(request));
    const resolution = await resolvePython();
    if (!resolution.ok) {
      release();
      return json({ error: "python_unavailable", python: resolution }, { status: 503 });
    }

    const args = buildScraperArgs(body, { resolveDatabasePath: resolveSandboxedPath });
    activeScrape = {
      id,
      startedAt: activeScrape.startedAt,
      status: "running",
      command: [resolution.label ?? resolution.command, ...args].join(" ")
    };

    let consumerClosed = false;
    let terminate: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const child = spawnPython(resolution, args);
        let stdoutBuffer = "";
        let finished = false;
        const terminalCandidates: RunOutcome[] = [];
        let processError: Error | undefined;
        const terminator = createProcessTerminator(child);

        const enqueue = (chunk: Uint8Array) => {
          if (consumerClosed || finished) return;
          try {
            controller.enqueue(chunk);
          } catch {
            consumerClosed = true;
          }
        };

        const finish = (outcome: RunOutcome) => {
          if (finished) return;
          finished = true;
          terminator.clear();
          request.signal.removeEventListener("abort", terminate!);
          if (!consumerClosed) {
            try {
              controller.enqueue(encodeSse("outcome", { type: "outcome", outcome }));
            } catch {
              consumerClosed = true;
            }
          }
          release();
          if (consumerClosed) return;
          consumerClosed = true;
          try {
            controller.close();
          } catch {
            // consumer already cancelled the stream
          }
        };

        terminate = () => {
          if (terminator.requested || child.exitCode !== null) return;
          if (activeScrape?.id === id) activeScrape.status = "terminating";
          terminator.terminate();
        };

        request.signal.addEventListener("abort", terminate, { once: true });
        if (request.signal.aborted) {
          terminate();
        }
        enqueue(encodeSse("started", { id, scrape: activeScrape }));

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              forwardScraperEvent(JSON.parse(line), enqueue, terminalCandidates);
            } catch {
              enqueue(encodeSse("error", { error: "Invalid JSON emitted by scraper stdout." }));
            }
          }
        });

        child.stderr.on("data", (chunk: Buffer) => {
          enqueue(encodeSse("log", { stream: "stderr", message: chunk.toString("utf8") }));
        });

        child.on("error", (error) => {
          processError = error;
        });

        child.on("close", (code, signal) => {
          if (finished) return;
          if (stdoutBuffer.trim()) {
            try {
              forwardScraperEvent(JSON.parse(stdoutBuffer), enqueue, terminalCandidates);
            } catch {
              enqueue(encodeSse("error", { error: "Invalid trailing JSON emitted by scraper stdout." }));
            }
          }
          finish(
            processError
              ? failedRunOutcome(processError.message)
              : resolveRunTermination(terminalCandidates, code, signal, terminator.requested)
          );
        });
      },
      cancel() {
        // Client disconnected without an abort signal: stop the child so the
        // single-scrape slot is freed once it exits.
        consumerClosed = true;
        terminate?.();
      }
    });

    return new Response(stream, { headers: sseHeaders() });
  } catch (error) {
    release();
    return badRequest(error);
  }
}

type Enqueue = (chunk: Uint8Array) => void;

function forwardScraperEvent(value: unknown, enqueue: Enqueue, outcomes: RunOutcome[]): void {
  const event = typeof value === "object" && value !== null ? value as { type?: string } : {};
  if (event.type === "outcome") {
    const outcome = parseRunOutcome(value);
    if (outcome) outcomes.push(outcome);
    else outcomes.push(failedRunOutcome("The scraper emitted an invalid terminal outcome."));
    return;
  }
  enqueue(encodeSse(event.type ?? "message", event));
}
