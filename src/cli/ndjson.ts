export type ScrapeEvent =
  | { type: "site_started"; site: string; category?: string }
  | { type: "progress"; site: string; category?: string; percent?: number; page?: number; pages_total?: number; products_seen?: number; skipped?: boolean }
  | { type: "site_failed"; site: string; category?: string; error: string }
  | { type: "done"; products_written?: number }
  | { type: "error"; error: string };

export type NdjsonParseResult = {
  events: ScrapeEvent[];
  buffer: string;
  invalidLines: string[];
};

export function parseNdjsonChunk(buffer: string, chunk: string): NdjsonParseResult {
  const lines = `${buffer}${chunk}`.split(/\r?\n/);
  const nextBuffer = lines.pop() ?? "";
  const events: ScrapeEvent[] = [];
  const invalidLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const event = parseScrapeEvent(line);
    if (event) events.push(event);
    else invalidLines.push(line);
  }

  return { events, buffer: nextBuffer, invalidLines };
}

export function parseTrailingNdjson(buffer: string): NdjsonParseResult {
  return parseNdjsonChunk("", buffer.endsWith("\n") ? buffer : `${buffer}\n`);
}

export function parseScrapeEvent(line: string): ScrapeEvent | undefined {
  try {
    const value = JSON.parse(line) as Partial<ScrapeEvent>;
    if (!value || typeof value !== "object" || !("type" in value)) return undefined;
    if (value.type === "done") return { type: "done", products_written: numberValue(value.products_written) };
    if (value.type === "error" && typeof value.error === "string") return { type: "error", error: value.error };
    if (value.type === "site_failed" && typeof value.site === "string") {
      return { type: "site_failed", site: value.site, category: stringValue(value.category), error: stringValue(value.error) ?? "site failed" };
    }
    if (value.type === "site_started" && typeof value.site === "string") {
      return { type: "site_started", site: value.site, category: stringValue(value.category) };
    }
    if (value.type === "progress" && typeof value.site === "string") {
      return {
        type: "progress",
        site: value.site,
        category: stringValue(value.category),
        percent: numberValue(value.percent),
        page: numberValue(value.page),
        pages_total: numberValue(value.pages_total),
        products_seen: numberValue(value.products_seen),
        skipped: typeof value.skipped === "boolean" ? value.skipped : undefined
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
