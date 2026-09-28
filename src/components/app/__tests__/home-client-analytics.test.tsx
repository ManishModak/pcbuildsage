/**
 * src/components/app/__tests__/home-client-analytics.test.tsx
 *
 * M2: the two client analytics events are wired at the call sites G1 created.
 * Effects never run under renderToStaticMarkup (node env, no DOM), so:
 * - onboarding_completed is verified by capturing the Wizard onComplete prop
 *   through mocked modules and invoking it (proves the real prop fires it);
 * - landing_view is verified by asserting the effect wiring in the source
 *   (same source-grep precedent as the guides no-network test).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ready: true,
  onboarded: false,
  wizardOnComplete: null as null | (() => void),
  fetchCalls: [] as Array<{ url: string; init: RequestInit }>
}));

vi.mock("@/components/app/app-provider", () => ({
  useApp: () => ({ config: { onboarded: state.onboarded }, ready: state.ready })
}));

vi.mock("@/features/wizard/wizard", () => ({
  Wizard: ({ onComplete }: { onComplete: () => void }) => {
    state.wizardOnComplete = onComplete;
    return null;
  }
}));

vi.mock("@/features/chat/chat-workspace", () => ({
  ChatWorkspace: () => null
}));

vi.mock("@/components/app/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

import { HomeClient, resetHomeClientEventsForTesting } from "@/components/app/home-client";

beforeEach(() => {
  state.ready = true;
  state.onboarded = false;
  state.wizardOnComplete = null;
  state.fetchCalls = [];
  resetHomeClientEventsForTesting();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      state.fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }));
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M2 client event wiring in HomeClient", () => {
  it("Wizard onComplete fires onboarding_completed exactly once", () => {
    renderToStaticMarkup(<HomeClient landing={<div>landing</div>} />);
    expect(typeof state.wizardOnComplete).toBe("function");
    state.wizardOnComplete?.();
    state.wizardOnComplete?.();
    const bodies = state.fetchCalls.map((call) => JSON.parse(String(call.init.body)));
    expect(bodies).toEqual([{ event: "onboarding_completed" }]);
  });

  it("does not fire onboarding_completed for onboarded users (chat path)", () => {
    state.onboarded = true;
    renderToStaticMarkup(<HomeClient landing={<div>landing</div>} />);
    expect(state.wizardOnComplete).toBeNull();
    expect(state.fetchCalls).toHaveLength(0);
  });

  it("wires a one-shot landing_view effect for the pre-hydration landing", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "components", "app", "home-client.tsx"), "utf8");
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(!ready\) fireOnce\("landing_view"\)/);
    expect(source).toContain('fireOnce(event: "landing_view" | "onboarding_completed")');
  });
});
