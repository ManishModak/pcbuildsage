/**
 * src/components/app/__tests__/home-client-analytics.test.tsx
 *
 * M2: the two client analytics events are wired at the call sites G1 created.
 * Effects never run under renderToStaticMarkup (node env, no DOM), so:
 * - onboarding_completed is verified by capturing the Wizard onComplete prop
 *   through mocked modules and invoking it (proves the real prop fires it);
 * - landing_view is verified through its pure gate (landingViewDue) plus the
 *   effect wiring in the source (same source-grep precedent as the guides
 *   no-network test).
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

import { CONFIG_KEY, RETURNING_BOOTSTRAP } from "@/lib/client-config-store";
import { HomeClient, landingViewDue, resetHomeClientEventsForTesting } from "@/components/app/home-client";

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

  it("counts landing_view only for first-time visitors, after hydration", () => {
    expect(landingViewDue(false, false)).toBe(false);
    expect(landingViewDue(true, true)).toBe(false);
    expect(landingViewDue(true, false)).toBe(true);
    const source = readFileSync(path.join(process.cwd(), "src", "components", "app", "home-client.tsx"), "utf8");
    expect(source).toMatch(/if \(landingViewDue\(ready, config\.onboarded\)\) fireOnce\("landing_view"\)/);
  });

  it("keeps the landing in pre-hydration HTML, with a spinner for returning users", () => {
    state.ready = false;
    const html = renderToStaticMarkup(<HomeClient landing={<div>landing copy</div>} />);
    expect(html).toContain('<div data-landing=""><div>landing copy</div></div>');
    expect(html).toContain("data-returning-spinner");
  });

  it.each([
    [JSON.stringify({ onboarded: true }), true],
    [JSON.stringify({ onboarded: false }), false],
    [null, false],
    ["{not json", false]
  ])("head bootstrap marks returning users (saved config %s)", (saved, returning) => {
    const setAttribute = vi.fn();
    new Function("localStorage", "document", RETURNING_BOOTSTRAP)(
      { getItem: (key: string) => (key === CONFIG_KEY ? saved : null) },
      { documentElement: { setAttribute } }
    );
    expect(setAttribute.mock.calls.length > 0).toBe(returning);
  });
});
