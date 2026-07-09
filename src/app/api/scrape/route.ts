import { z } from "zod";
import { resolveSandboxedPath } from "../_lib/paths";
import { buildScraperArgs, resolvePython, spawnScraper } from "../_lib/python";
import { badRequest, json, readJson } from "../_lib/responses";
import { encodeSse, sseHeaders } from "../_lib/sse";

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
    const body = sandboxScrapeConfig(scrapeSchema.parse(await readJson(request)));
    const resolution = await resolvePython();
    if (!resolution.ok) {
      release();
      return json({ error: "python_unavailable", python: resolution }, { status: 503 });
    }

    const args = buildScraperArgs(body);
    activeScrape = {
      id,
      startedAt: activeScrape.startedAt,
      status: "running",
      command: [resolution.label ?? resolution.command, ...args].join(" ")
    };

    let closed = false;
    let terminate: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const child = spawnScraper(resolution, args);
        let stdoutBuffer = "";
        let termTimer: NodeJS.Timeout | undefined;

        const enqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        };

        const close = () => {
          if (termTimer) clearTimeout(termTimer);
          release();
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // consumer already cancelled the stream
          }
        };

        terminate = () => {
          if (child.exitCode !== null || child.killed) return;
          if (activeScrape?.id === id) activeScrape.status = "terminating";
          child.kill("SIGTERM");
          termTimer = setTimeout(() => {
            if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
          }, 3000);
        };

        request.signal.addEventListener("abort", terminate, { once: true });
        enqueue(encodeSse("started", { id, scrape: activeScrape }));

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as { type?: string };
              enqueue(encodeSse(event.type ?? "message", event));
            } catch {
              enqueue(encodeSse("error", { error: "Invalid JSON emitted by scraper stdout." }));
            }
          }
        });

        child.stderr.on("data", (chunk: Buffer) => {
          enqueue(encodeSse("log", { stream: "stderr", message: chunk.toString("utf8") }));
        });

        child.on("error", (error) => {
          enqueue(encodeSse("error", { error: error.message }));
          close();
        });

        child.on("close", (code, signal) => {
          if (stdoutBuffer.trim()) {
            try {
              const event = JSON.parse(stdoutBuffer) as { type?: string };
              enqueue(encodeSse(event.type ?? "message", event));
            } catch {
              enqueue(encodeSse("error", { error: "Invalid trailing JSON emitted by scraper stdout." }));
            }
          }
          enqueue(encodeSse(code === 0 ? "exit" : "error", { code, signal }));
          close();
        });
      },
      cancel() {
        // Client disconnected without an abort signal: stop the child so the
        // single-scrape slot is freed once it exits.
        closed = true;
        terminate?.();
      }
    });

    return new Response(stream, { headers: sseHeaders() });
  } catch (error) {
    release();
    return badRequest(error);
  }
}

function sandboxScrapeConfig(config: z.infer<typeof scrapeSchema>): z.infer<typeof scrapeSchema> {
  return config.db ? { ...config, db: resolveSandboxedPath(config.db) } : config;
}
