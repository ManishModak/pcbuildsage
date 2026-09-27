// Structural guard for the chat header effect, not a test of React itself.
//
// There is no DOM environment in this repo (no jsdom, happy-dom,
// react-test-renderer or testing-library, and new dependencies are forbidden)
// and renderToStaticMarkup never runs effects, so the real ChatView cannot be
// mounted and no test in the repository executes that effect. What this file
// does instead is model the hook semantics the effect depends on - useState
// bail-out, useRef, useMemo / useCallback dep comparison, useEffect ordering and
// gating, render-phase setState, and a provider that re-renders its consumers
// whenever it is handed a new element - and drive the *real* functions from
// build-versions through it.
//
// The property asserted is the one that prevents the loop: the effect publishes
// a header element, the provider re-renders, the memo chain recomputes, and the
// effect gets another chance to publish. A stable input must converge, and a
// churning input must still refresh the header rather than go stale, so the
// guard cannot be papering over a stale header instead of preventing a loop.
//
// The reported "Maximum update depth exceeded" was never reproducible on this
// base: with the message store returning the same array on every read, nothing
// in the dependency array gains a new identity, so an unguarded effect
// converges too. The simulation below can force that churn, which is the case
// that would loop, and shows the signature is what ends it.
import { describe, expect, it } from "vitest";
import {
  buildHeaderSignature,
  buildsFingerprint,
  findAllBuildVersions,
  followNewestVersion,
  openedBuildsForSession,
  resolveSelectedVersion,
  type BuildVersion
} from "../build-versions";
import { resolveBuildTotal, type DerivedBuild } from "../build-derive";
import { formatPrice } from "@/lib/format";
import { sessionSignature } from "../session-save-queue";

/** React's own threshold for nested updates before it gives up. */
const RENDER_LIMIT = 50;

type Msg = Parameters<typeof findAllBuildVersions>[0][number];

type PanelState = {
  openedBuilds: { sessionId: string; builds: DerivedBuild[] } | null;
  selectedVersionId: string | undefined;
  selectedAlternativeIndex: number;
  sidePanelOpen: boolean;
  isCompacting: boolean;
  contextExceededNotice: string | null;
  prevSessionId: string;
  headerSuffix: unknown;
};

type Pass = {
  allBuildVersions: BuildVersion[];
  activeVersionObj: BuildVersion | undefined;
  latestBuilds: DerivedBuild[] | null;
  displayBuilds: DerivedBuild[] | null;
  headerBuildPrice: string | null;
  headerSignature: string;
};

type SimulateOptions = {
  sessionId: string;
  messages: Msg[];
  currency: string;
  isActive: boolean;
  streaming?: boolean;
  /**
   * Hand back a new but equal `messages` array on every provider re-render, the
   * way a store that rebuilds its snapshot would. This is the churn that makes
   * an identity-based guard loop.
   */
  churnMessages?: boolean;
};

function depsChanged(prev: unknown[] | undefined, next: unknown[]): boolean {
  if (!prev) return true;
  if (prev.length !== next.length) return true;
  return next.some((value, index) => !Object.is(value, prev[index]));
}

function lastAssistantId(messages: Msg[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].id;
  }
  return undefined;
}

function cloneMessages(messages: Msg[]): Msg[] {
  return JSON.parse(JSON.stringify(messages)) as Msg[];
}

/**
 * Run the panel + header chain to quiescence and report what it did.
 * Throws "Maximum update depth exceeded" if it does not converge.
 */
function simulate(props: SimulateOptions): {
  renders: number;
  setHeaderSuffixCalls: number;
  pass: Pass;
} {
  let state: PanelState = {
    openedBuilds: null,
    selectedVersionId: undefined,
    selectedAlternativeIndex: 0,
    sidePanelOpen: false,
    isCompacting: false,
    contextExceededNotice: null,
    prevSessionId: props.sessionId,
    headerSuffix: null
  };
  const refs = {
    lastHeaderSignature: null as string | null,
    lastLatestBuildsSignature: "",
    lastVersionId: undefined as string | undefined,
    setHeaderSuffixCalls: 0
  };
  const memos = new Map<string, { deps: unknown[]; value: unknown }>();
  const memo = <T,>(key: string, deps: unknown[], compute: () => T): T => {
    const prior = memos.get(key);
    if (prior && !depsChanged(prior.deps, deps)) return prior.value as T;
    const value = compute();
    memos.set(key, { deps, value });
    return value;
  };
  const patchState = (patch: Partial<PanelState>): boolean => {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof PanelState, PanelState[keyof PanelState]]
    >) {
      if (!Object.is(state[key], value)) changed = true;
    }
    if (!changed) return false; // React bails out on an identical value
    state = { ...state, ...patch };
    return true;
  };

  // Provider state lives above the consumer: a new element identity re-renders
  // the provider, and therefore the consumer.
  let messages = props.messages;
  let providerRerenderPending = true;
  let renders = 0;
  let pass: Pass | null = null;

  for (let step = 0; step < RENDER_LIMIT * 4; step++) {
    if (++renders > RENDER_LIMIT) throw new Error("Maximum update depth exceeded");
    const microtasks: Array<() => void> = [];
    let dirty = false;

    // Render phase: the sessionId adjustment, as chat-view does it. It
    // converges in one pass because the stored id is updated with it.
    if (props.sessionId !== state.prevSessionId) {
      state = {
        ...state,
        prevSessionId: props.sessionId,
        isCompacting: false,
        contextExceededNotice: null
      };
      dirty = true;
    }

    const currency = props.currency;
    const streaming = props.streaming ?? false;

    const allBuildVersions = memo("allBuildVersions", [messages, currency], () =>
      findAllBuildVersions(messages, currency, {
        streamingMessageId: streaming ? lastAssistantId(messages) : undefined
      })
    );
    const activeVersionObj = memo(
      "activeVersionObj",
      [allBuildVersions, state.selectedVersionId],
      () => resolveSelectedVersion(allBuildVersions as BuildVersion[], state.selectedVersionId)
    );
    const latestBuilds = memo("latestBuilds", [allBuildVersions, messages, currency], () => {
      const versions = allBuildVersions as BuildVersion[];
      return versions.length > 0 ? versions[versions.length - 1].builds : null;
    });
    const activeBuilds = openedBuildsForSession(state.openedBuilds, props.sessionId);
    const displayBuilds = memo(
      "displayBuilds",
      [activeVersionObj, activeBuilds, latestBuilds],
      () => (activeVersionObj as BuildVersion | undefined)?.builds ?? activeBuilds ?? latestBuilds
    );

    const safeAlternativeIndex = Math.min(
      Math.max(0, state.selectedAlternativeIndex),
      Math.max(0, (displayBuilds as DerivedBuild[] | null)?.length ?? 1) - 1
    );
    const activeBuild = (displayBuilds as DerivedBuild[] | null | undefined)?.[safeAlternativeIndex];
    const headerBuildPrice = activeBuild
      ? formatPrice(resolveBuildTotal(activeBuild), activeBuild.currency)
      : null;

    const headerSignature = buildHeaderSignature({
      sessionId: props.sessionId,
      model: "model-x",
      streaming,
      compacting: state.isCompacting,
      sidePanelOpen: state.sidePanelOpen,
      messageCount: messages.length,
      transcript: sessionSignature(messages),
      error: "",
      currency,
      countryCode: "IN",
      buildPrice: headerBuildPrice,
      builds: displayBuilds as DerivedBuild[] | null
    });

    pass = {
      allBuildVersions: allBuildVersions as BuildVersion[],
      activeVersionObj: activeVersionObj as BuildVersion | undefined,
      latestBuilds: latestBuilds as DerivedBuild[] | null,
      displayBuilds: displayBuilds as DerivedBuild[] | null,
      headerBuildPrice,
      headerSignature
    };

    // Effects, in source order, after commit, each gated on its own deps.

    // E1: a version that just arrived supersedes the selection.
    const e1deps = [allBuildVersions, state.selectedVersionId];
    if (depsChanged(memos.get("e1")?.deps, e1deps)) {
      memos.set("e1", { deps: e1deps, value: null });
      const versions = allBuildVersions as BuildVersion[];
      const nextId = followNewestVersion(state.selectedVersionId, refs.lastVersionId, versions);
      refs.lastVersionId = versions[versions.length - 1]?.id;
      if (nextId !== state.selectedVersionId) {
        dirty = patchState({ selectedVersionId: nextId }) || dirty;
      }
    }

    // E2: open the panel on the newest build, once per distinct build.
    const setActiveBuilds = memo("setActiveBuilds", [props.sessionId], () => {
      return (builds: DerivedBuild[] | null) => {
        dirty = patchState({ openedBuilds: builds ? { sessionId: props.sessionId, builds } : null }) || dirty;
      };
    });
    const e2deps = [latestBuilds, props.isActive, setActiveBuilds];
    if (depsChanged(memos.get("e2")?.deps, e2deps)) {
      memos.set("e2", { deps: e2deps, value: null });
      const latest = latestBuilds as DerivedBuild[] | null;
      const signature = buildsFingerprint(latest);
      if (latest && signature && signature !== refs.lastLatestBuildsSignature) {
        refs.lastLatestBuildsSignature = signature;
        microtasks.push(() => {
          dirty = patchState({ openedBuilds: { sessionId: props.sessionId, builds: latest } }) || dirty;
        });
      }
    }

    // E3: publish the header, guarded by the value signature.
    const e3deps = [
      props.isActive,
      headerSignature,
      "model-x",
      streaming,
      state.isCompacting,
      displayBuilds,
      headerBuildPrice,
      state.sidePanelOpen,
      messages,
      props.sessionId,
      currency,
      "IN"
    ];
    if (depsChanged(memos.get("e3")?.deps, e3deps)) {
      memos.set("e3", { deps: e3deps, value: null });
      if (props.isActive && refs.lastHeaderSignature !== headerSignature) {
        refs.lastHeaderSignature = headerSignature;
        const element = { __header: true, signature: headerSignature };
        if (!Object.is(state.headerSuffix, element)) {
          state = { ...state, headerSuffix: element };
          refs.setHeaderSuffixCalls += 1;
          providerRerenderPending = true;
        }
      }
    }

    for (const task of microtasks) task();
    if (!dirty && !providerRerenderPending) break;
    providerRerenderPending = false;
    if (props.churnMessages) messages = cloneMessages(messages);
  }

  if (!pass) throw new Error("no render happened");
  return { renders, setHeaderSuffixCalls: refs.setHeaderSuffixCalls, pass };
}

const markdownSession = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Just tell me a build in a table." }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: [
          "| Component | Part | Price |",
          "|---|---|---|",
          "| GPU | RTX 4060 | ₹29,000 |",
          "| CPU | AMD Ryzen 5 5600 | ₹11,500 |"
        ].join("\n")
      }
    ]
  }
] as unknown as Msg[];

const validatedSession = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-validate_build",
        toolCallId: "v1",
        state: "output-available",
        input: { label: "Balanced", parts: { gpu: "g" } },
        output: {
          valid: true,
          issues: [],
          resolved: {},
          summary: { passed: 1, failed: 0, unverified: 0, text: "1 check passed" },
          snapshot: {
            label: "Balanced",
            components: [
              { category: "gpu", name: "RTX 4060", price: 28500, currency: "INR" }
            ],
            total: 28500,
            subtotal: 28500,
            currency: "INR",
            is_complete: true,
            component_count: 1,
            unpriced_count: 0,
            missing_prices: [],
            currencies: ["INR"],
            parts: {},
            valid: true,
            created_at: "2026-01-01T00:00:00.000Z"
          }
        }
      }
    ]
  }
] as unknown as Msg[];

describe("header effect: structural guard against re-arming itself", () => {
  it("converges and publishes once for a build parsed out of prose", () => {
    const result = simulate({
      sessionId: "s1",
      messages: markdownSession,
      currency: "INR",
      isActive: true
    });
    expect(result.renders).toBeLessThan(RENDER_LIMIT);
    expect(result.setHeaderSuffixCalls).toBe(1);
    expect(result.pass.headerBuildPrice).toBe("₹40,500.00");
    expect(result.pass.allBuildVersions).toHaveLength(1);
  });

  it("converges and publishes once for a build recovered from a snapshot", () => {
    const result = simulate({
      sessionId: "s1",
      messages: validatedSession,
      currency: "INR",
      isActive: true
    });
    expect(result.renders).toBeLessThan(RENDER_LIMIT);
    expect(result.setHeaderSuffixCalls).toBe(1);
    expect(result.pass.headerBuildPrice).toBe("₹28,500.00");
    expect(result.pass.allBuildVersions[0].label).toBe("Validated — not presented yet");
  });

  it("still converges when the message store hands back a new array every read", () => {
    // The churn that makes an identity-based guard loop: displayBuilds is a new
    // object every pass, so an unguarded effect would publish, re-render,
    // republish and repeat until React gave up. The signature is equal, so the
    // provider never re-renders and the chain ends on the first publish.
    const result = simulate({
      sessionId: "s1",
      messages: markdownSession,
      currency: "INR",
      isActive: true,
      churnMessages: true
    });
    expect(result.renders).toBeLessThan(RENDER_LIMIT);
    expect(result.setHeaderSuffixCalls).toBe(1);
  });

  it("gives a different header to two transcripts that differ only in reply text", () => {
    const reply = (text: string): Msg[] =>
      [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text }] }
      ] as unknown as Msg[];

    const before = simulate({
      sessionId: "s1",
      messages: reply("Starting with the "),
      currency: "INR",
      isActive: true,
      streaming: true
    });
    const after = simulate({
      sessionId: "s1",
      messages: reply("Starting with the GPU."),
      currency: "INR",
      isActive: true,
      streaming: true
    });

    // Same message count throughout: only the content differs, and the header
    // still moves, so the transcript menu cannot export a stale reply.
    expect(before.pass.headerSignature).not.toBe(after.pass.headerSignature);
    expect(after.setHeaderSuffixCalls).toBe(1);
  });

  it("moves the selection to a version that arrives later", () => {
    const first = simulate({
      sessionId: "s1",
      messages: markdownSession,
      currency: "INR",
      isActive: true
    });
    expect(first.pass.allBuildVersions).toHaveLength(1);

    const second = simulate({
      sessionId: "s1",
      messages: [
        ...markdownSession,
        { id: "u2", role: "user", parts: [{ type: "text", text: "and an M2?" }] },
        {
          id: "a2",
          role: "assistant",
          parts: [
            {
              type: "tool-present_build",
              toolCallId: "call-2",
              state: "output-available",
              input: {
                builds: [
                  {
                    label: "Real",
                    parts: [{ category: "gpu", name: "RTX 4070", price: 54000, currency: "INR" }]
                  }
                ]
              }
            }
          ]
        }
      ] as unknown as Msg[],
      currency: "INR",
      isActive: true
    });
    expect(second.renders).toBeLessThan(RENDER_LIMIT);
    expect(second.pass.allBuildVersions).toHaveLength(2);
    expect(second.pass.activeVersionObj?.id).toBe(second.pass.allBuildVersions[1].id);
  });

  it("drops the previous chat's build on a session switch", () => {
    const sessionA = simulate({
      sessionId: "session-a",
      messages: markdownSession,
      currency: "INR",
      isActive: true
    });
    expect(sessionA.pass.displayBuilds).not.toBeNull();

    // Session B has no build of its own and ChatView is not remounted.
    const sessionB = simulate({
      sessionId: "session-b",
      messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "hello" }] }] as unknown as Msg[],
      currency: "INR",
      isActive: true
    });
    expect(sessionB.pass.displayBuilds).toBeNull();
    expect(sessionB.pass.headerBuildPrice).toBeNull();
  });
});
