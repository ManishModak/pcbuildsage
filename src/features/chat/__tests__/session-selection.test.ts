import { describe, expect, it } from "vitest";
import type { SessionDetail } from "@/lib/api-client";
import { invalidateSessionSelection, selectLatestSession } from "../session-selection";

function session(id: string): SessionDetail {
  return {
    id,
    revision: 0,
    title: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    country_code: null,
    currency: null,
    messages: [],
    build_state: null
  };
}

describe("selectLatestSession", () => {
  it("lets fast B win when delayed A finishes last", async () => {
    const resolvers = new Map<string, (value: SessionDetail) => void>();
    const load = (id: string) => new Promise<SessionDetail>((resolve) => resolvers.set(id, resolve));
    const committed: string[] = [];
    const guard = { generation: 0 };

    const loadA = selectLatestSession(guard, "a", load, (value) => committed.push(value.id));
    const loadB = selectLatestSession(guard, "b", load, (value) => committed.push(value.id));
    resolvers.get("b")!(session("b"));
    await loadB;
    resolvers.get("a")!(session("a"));
    await loadA;

    expect(committed).toEqual(["b"]);
  });

  it("does not commit a failed or missing load", async () => {
    const committed: string[] = [];
    const guard = { generation: 0 };

    await selectLatestSession(guard, "failed", async () => { throw new Error("offline"); }, (value) => committed.push(value.id));
    await selectLatestSession(guard, "missing", async () => null, (value) => committed.push(value.id));

    expect(committed).toEqual([]);
  });

  it("does not commit a load invalidated by a newer action", async () => {
    let resolve!: (value: SessionDetail) => void;
    const load = new Promise<SessionDetail>((done) => { resolve = done; });
    const committed: string[] = [];
    const guard = { generation: 0 };

    const pending = selectLatestSession(guard, "a", async () => load, (value) => committed.push(value.id));
    invalidateSessionSelection(guard);
    resolve(session("a"));
    await pending;

    expect(committed).toEqual([]);
  });
});
