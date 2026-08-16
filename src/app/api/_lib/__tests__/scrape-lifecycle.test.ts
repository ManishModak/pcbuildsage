import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const pythonMocks = vi.hoisted(() => ({
  children: [] as FakeChild[],
  resolvePython: vi.fn(async () => ({ ok: true, command: "python", args: [], label: "python" })),
  spawnPython: vi.fn(() => {
    const child = new FakeChild();
    pythonMocks.children.push(child);
    return child;
  })
}));

vi.mock("@/lib/server/python-process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/python-process")>()),
  resolvePython: pythonMocks.resolvePython,
  spawnPython: pythonMocks.spawnPython
}));

import { resolveRunTermination } from "@/contracts/scrape";
import { POST } from "../../scrape/route";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn(() => true);
}

const successOutcome = {
  status: "succeeded" as const,
  jobs_total: 1,
  jobs_succeeded: 1,
  jobs_failed: 0,
  jobs_skipped: 0,
  products_written: 2,
  errors: []
};

afterEach(() => {
  vi.useRealTimers();
  pythonMocks.children.length = 0;
  pythonMocks.spawnPython.mockClear();
  pythonMocks.resolvePython.mockClear();
});

describe("scrape process lifecycle", () => {
  it("settles once when child error is followed by close", async () => {
    const response = await startScrape();
    const child = pythonMocks.children[0];
    const text = response.text();

    child.emit("error", new Error("spawn failed"));
    child.emit("close", 1, null);

    const body = await text;
    expect(body.match(/event: outcome/g)).toHaveLength(1);
    expect(outcomeFromSse(body)).toMatchObject({ status: "failed", errors: ["spawn failed"] });
  });

  it("escalates an ignored SIGINT to SIGKILL and reports cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const response = await startScrape(controller.signal);
    const child = pythonMocks.children[0];
    const text = response.text();

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", null, "SIGKILL");
    expect(outcomeFromSse(await text)).toMatchObject({ status: "cancelled" });
  });
});

describe("terminal outcome validation", () => {
  it("fails a clean close with no terminal outcome", () => {
    expect(resolveRunTermination([], 0, null, false)).toMatchObject({ status: "failed" });
  });

  it("rejects duplicate terminal outcomes", () => {
    expect(resolveRunTermination([successOutcome, successOutcome], 0, null, false)).toMatchObject({
      status: "failed",
      errors: ["The scraper emitted more than one terminal outcome."]
    });
  });

  it("accepts one successful outcome only with a successful exit", () => {
    expect(resolveRunTermination([successOutcome], 0, null, false)).toEqual(successOutcome);
    expect(resolveRunTermination([successOutcome], 1, null, false)).toMatchObject({ status: "failed" });
  });
});

function startScrape(signal?: AbortSignal): Promise<Response> {
  return POST(new Request("http://localhost/api/scrape", {
    method: "POST",
    body: JSON.stringify({ profile: "india" }),
    signal
  }));
}

function outcomeFromSse(body: string): unknown {
  const frame = body.split("\n\n").find((part) => part.startsWith("event: outcome"));
  const data = frame?.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
  return data ? (JSON.parse(data) as { outcome: unknown }).outcome : undefined;
}
