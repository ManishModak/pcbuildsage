import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildHeaderSignature,
  buildsFingerprint,
  findAllBuildVersions,
  followNewestVersion,
  openedBuildsForSession,
  resolveSelectedVersion,
  VALIDATED_VERSION_LABEL
} from "../build-versions";
import { BuildCard } from "../build-card";
import { BuildErrorBoundary } from "../build-error-boundary";
import { MessageView, type ChatUIMessage } from "../message";
import type { DerivedBuild } from "../build-derive";
import { sessionSignature } from "../session-save-queue";

// Ids and shapes copied from the real interrupted session in data/sessions.db
// (id 371612d7-294e-4a53-9fc3-2de07ecf2340): four finished validate_build
// calls with snapshots, one validate_build stuck in input-streaming, and no
// present_build anywhere, so its build panel rendered blank.
const RAM_ID = "1ee22f4e68844a8440d5ef87693f8319fb21ba7b";
const MOTHERBOARD_ID = "d1d2044f9a831b22b749eeb825e4a54766f76ec1";
const STORAGE_ID = "654105021be32bb123e9d04c1563f2392880fce2";
const PSU_ID = "58450455bb4ee5fb80c47738327689caaf21449d";
const CASE_ID = "54a947a6a0532789d59101f1e417b1c72588f82e";

/** A finished validate_build whose snapshot has two unpriced parts. */
function finishedValidation(
  toolCallId: string,
  label: string,
  snapshotOverrides: Record<string, unknown> = {}
): ChatUIMessage["parts"][number] {
  return {
    type: "tool-validate_build",
    toolCallId,
    state: "output-available",
    input: {
      label,
      parts: { cpu: "amd-ryzen-5-3400g", motherboard: MOTHERBOARD_ID, ram: RAM_ID }
    },
    output: {
      valid: true,
      issues: [],
      resolved: {},
      checks: [],
      summary: { passed: 3, failed: 0, unverified: 2, text: "3 passed · 2 unverified" },
      snapshot: {
        label,
        components: [
          // A part the catalog could not resolve: the model passed a product
          // id, and the snapshot reused it as the name with no price.
          { category: "cpu", name: "amd-ryzen-5-3400g", price: null, currency: "INR", included: false },
          {
            category: "motherboard",
            product_id: MOTHERBOARD_ID,
            name: "ASRock A520M-HVS M-ATX Motherboard",
            price: 4900,
            currency: "INR",
            retailer: "MDComputers"
          },
          { category: "ram", product_id: RAM_ID, name: RAM_ID, price: null, currency: "INR", included: false },
          {
            category: "storage",
            product_id: STORAGE_ID,
            name: "EVM 512GB NVMe Gen3 SSD",
            price: 6880,
            currency: "INR",
            retailer: "MDComputers"
          },
          {
            category: "psu",
            product_id: PSU_ID,
            name: "Ant Esports VS600L - 600 Watt Non-Modular Power Supply",
            price: 2240,
            currency: "INR",
            retailer: "VedantComputers"
          },
          {
            category: "case",
            product_id: CASE_ID,
            name: "Ant Esports SI28 ATX Mid Tower Case",
            price: 2380,
            currency: "INR",
            retailer: "MDComputers"
          }
        ],
        total: null,
        subtotal: 16400,
        currency: "INR",
        is_complete: false,
        component_count: 6,
        unpriced_count: 2,
        missing_prices: ["cpu: amd-ryzen-5-3400g", `ram: ${RAM_ID}`],
        currencies: ["INR"],
        parts: { cpu: "amd-ryzen-5-3400g", ram: { product_id: RAM_ID, category: "ram" } },
        valid: true,
        created_at: "2026-09-14T14:56:33.674Z",
        ...snapshotOverrides
      }
    }
  } as unknown as ChatUIMessage["parts"][number];
}

const stuckSession: ChatUIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Budget gaming build under ₹45,000." }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "searching for parts" },
      {
        type: "tool-search_products",
        toolCallId: "s1",
        state: "output-available",
        input: { category: "ram", ddr: "DDR4" },
        output: { results: [] }
      },
      finishedValidation("RvUOcIhIs5fn8JJzg7gvTgExP1IoxiBQ", "APU Vega 11 competitive esports"),
      // Saved permanently in this state: the tool chip spins forever and the
      // call is replayed from storage on every reload.
      {
        type: "tool-validate_build",
        toolCallId: "Ldea3M1JeeXybcx2Pd2X47ODY1xzRW9N",
        state: "input-streaming",
        input: { parts: { case: CASE_ID, cooler: "133c1a8f540e34af40904a2300259497fb5616db" } }
      }
    ]
  },
  { id: "u2", role: "user", parts: [{ type: "text", text: "Use the product ids for CPU and RAM." }] },
  {
    id: "a2",
    role: "assistant",
    parts: [
      finishedValidation("QCpkwJ1LcUILYDVGysXacptHTJX4qIio", "Integrated-Graphics Competitive (3400G APU)"),
      finishedValidation("zYrcHPO6hun4v7l9STSX9qQHEtD9hndv", "Integrated-Graphics Competitive (3400G APU)"),
      finishedValidation("xcW55TuwFySPUsFqzPnBKZlTj78i5xpK", "Integrated-Graphics Competitive (3400G APU)", {
        component_count: 7
      })
    ]
  }
];

describe("build panel recovery: an interrupted chat still has a build", () => {
  it("recovers the real stuck session: validated builds, not a blank panel and not ₹0.00", () => {
    const versions = findAllBuildVersions(stuckSession, "INR");

    // Four finished validations exist across two turns, and neither turn ever
    // presented one, so each is a recovered version.
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.label)).toEqual([
      VALIDATED_VERSION_LABEL,
      VALIDATED_VERSION_LABEL
    ]);
    expect(versions[0].id).toBe("1:validated:RvUOcIhIs5fn8JJzg7gvTgExP1IoxiBQ");
    expect(versions[1].id).toBe("3:validated:xcW55TuwFySPUsFqzPnBKZlTj78i5xpK");
    expect(versions.some((v) => v.presentationId !== undefined)).toBe(false);

    // The panel shows the newest, which is the last validation of the session.
    const latest = versions[versions.length - 1];
    const build = latest.builds[0];
    expect(build.label).toBe("Integrated-Graphics Competitive (3400G APU)");
    expect(build.currency).toBe("INR");
    expect(build.total).toBeNull();
    expect(build.components).toHaveLength(6);

    const markup = renderToStaticMarkup(
      <BuildCard versions={versions} selectedVersionId={latest.id} inSidePanel />
    );

    // Two recovered versions share one label, so the picker disambiguates them.
    expect(markup).toContain(`${VALIDATED_VERSION_LABEL} · APU Vega 11 competitive esports`);
    expect(markup).toContain(
      `${VALIDATED_VERSION_LABEL} · Integrated-Graphics Competitive (3400G APU) (Latest)`
    );

    // Not blank: the parts the rules engine actually resolved are on screen.
    expect(markup).toContain("ASRock A520M-HVS M-ATX Motherboard");
    expect(markup).toContain("EVM 512GB NVMe Gen3 SSD");
    expect(markup).toContain("₹4,900");

    // A product id is never a part name: the unresolved RAM falls back to its
    // category label, and the id only ever shows in the secondary line.
    expect(markup).toContain('<span class="block text-sm text-text">Memory</span>');
    expect(markup).not.toContain(`text-text">${RAM_ID}`);

    // An incomplete snapshot has no total, and that reads as an em dash.
    expect(markup).toContain("—");
    expect(markup).not.toContain("₹0.00");
  });

  it("shows the validated builds in the message's own build button", () => {
    const versions = findAllBuildVersions(stuckSession, "INR");
    const markup = renderToStaticMarkup(
      <MessageView
        message={stuckSession[3]}
        versions={versions.filter((v) => v.messageIndex === 3)}
        currency="INR"
      />
    );

    expect(markup).toContain("Validated — not presented yet");
    expect(markup).toContain("Integrated-Graphics Competitive (3400G APU)");
    expect(markup).toContain('aria-label="View proposed build: Integrated-Graphics Competitive (3400G APU)"');
    // The button must not advertise a total it does not have.
    expect(markup).not.toContain("₹0.00");
  });

  it("never labels a snapshot-bearing turn as text-derived, however early it is", () => {
    // Two turns, each with a usable snapshot AND a build table in its prose.
    // The fallback exists for turns with no snapshot; both of these have one.
    const proseTable = [
      "Here is a build:",
      "",
      "| Component | Part | Price |",
      "|---|---|---|",
      "| GPU | RTX 4060 | ₹29,000 |",
      "| CPU | Ryzen 5 5600 | ₹11,200 |"
    ].join("\n");

    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          finishedValidation("v1", "First Draft"),
          { type: "text", text: proseTable }
        ]
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "Now with a discrete GPU" }] },
      {
        id: "a2",
        role: "assistant",
        parts: [
          finishedValidation("v2", "Second Draft"),
          { type: "text", text: proseTable }
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");

    // Both turns are recovered from their snapshots...
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.id)).toEqual(["1:validated:v1", "3:validated:v2"]);
    expect(versions.map((v) => v.label)).toEqual([
      VALIDATED_VERSION_LABEL,
      VALIDATED_VERSION_LABEL
    ]);
    // ...and the earlier one is not mistaken for a prose scrape.
    expect(versions[0].builds[0].textDerived).toBeUndefined();
    expect(versions[0].builds[0].label).toBe("First Draft");
    expect(versions[0].builds[0].components.map((c) => c.name)).toContain(
      "ASRock A520M-HVS M-ATX Motherboard"
    );
  });

  it("ignores a present_build that never finished in an already-finished message", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          finishedValidation("v1", "Partial Build"),
          {
            type: "tool-present_build",
            toolCallId: "call-partial",
            // Input written, tool never ran: the call was interrupted.
            state: "input-streaming",
            input: {
              builds: [
                {
                  label: "Partial Build",
                  product_ids: [MOTHERBOARD_ID, STORAGE_ID]
                }
              ]
            }
          } as unknown as ChatUIMessage["parts"][number]
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");

    // One version, and it is the validated one: the partial call is not a build.
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe(VALIDATED_VERSION_LABEL);
    expect(versions[0].id).toBe("1:validated:v1");
    expect(versions.some((v) => v.presentationId === "call-partial")).toBe(false);
    expect(versions[0].builds[0].components.map((c) => c.name)).toContain(
      "ASRock A520M-HVS M-ATX Motherboard"
    );
  });

  it("counts a present_build that is still streaming only while its own message streams", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-present_build",
            toolCallId: "call-live",
            state: "input-streaming",
            input: {
              builds: [
                {
                  label: "Live Build",
                  parts: [
                    { category: "gpu", name: "RTX 4060", price: 28500, currency: "INR" },
                    { category: "cpu", name: "Ryzen 5 5600", price: 11200, currency: "INR" }
                  ]
                }
              ]
            }
          }
        ]
      }
    ];

    // Loaded from storage or after a reload: nothing is live, so nothing counts.
    expect(findAllBuildVersions(messages, "INR")).toEqual([]);
    expect(findAllBuildVersions(messages, "INR", { streamingMessageId: "a-other" })).toEqual([]);

    const live = findAllBuildVersions(messages, "INR", { streamingMessageId: "a1" });
    expect(live).toHaveLength(1);
    expect(live[0].presentationId).toBe("call-live");
    expect(live[0].builds[0].label).toBe("Live Build");
  });

  it("still renders an old-format session that has no parts, no revision and no snapshots", () => {
    const oldSession = [
      {
        id: "old-1",
        role: "user",
        content: "Propose a gaming build"
      },
      {
        id: "old-2",
        role: "assistant",
        content: [
          "Here is a build:",
          "",
          "| Component | Part | Price |",
          "|---|---|---|",
          "| GPU | RTX 4060 | ₹29,000 |",
          "| CPU | AMD Ryzen 5 5600 | ₹11,500 |"
        ].join("\n")
      }
    ] as unknown as ChatUIMessage[];

    const versions = findAllBuildVersions(oldSession, "INR");
    expect(versions).toHaveLength(1);
    expect(versions[0].builds[0].components.map((c) => c.name)).toEqual([
      "RTX 4060",
      "AMD Ryzen 5 5600"
    ]);

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    expect(markup).toContain("RTX 4060");
    expect(markup).toContain("₹40,500");
  });
});

describe("matching a presented build to the validation that produced it", () => {
  it("falls back to product ids when the model relabelled the build", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          // Validated as "Value Pick" ...
          finishedValidation("v1", "Value Pick"),
          // ... and presented as something else entirely, with the same ids.
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Budget 1080p Competitive (renamed)",
                  product_ids: [MOTHERBOARD_ID, STORAGE_ID]
                }
              ]
            }
          } as unknown as ChatUIMessage["parts"][number]
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");
    expect(versions).toHaveLength(1);

    const build = versions[0].builds[0];
    // Matched by product id, so the catalog data and the verdict come through.
    expect(build.validation?.valid).toBe(true);
    expect(build.components.map((c) => c.name)).toContain("ASRock A520M-HVS M-ATX Motherboard");
    expect(build.total).toBeNull();
  });

  it("says the details are unavailable instead of naming raw product ids", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Untraceable Build",
                  product_ids: ["ffffffffffffffffffffffffffffffffffffffff"]
                }
              ]
            }
          } as unknown as ChatUIMessage["parts"][number]
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");
    expect(versions).toHaveLength(1);
    expect(versions[0].builds[0].detailsUnavailable).toBe(true);

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    expect(markup).toContain("Build details unavailable — ask the assistant to present it again");
    expect(markup).not.toContain("ffffffffffffffffffffffffffffffffffffffff");
    expect(markup).not.toContain("₹0.00");
  });

  it("lets the parts decide when two turns reuse the same build label", () => {
    // Both validations are called "Balanced": the parts, not the label, say
    // which one the presented build came from.
    const firstValidation = finishedValidation("v1", "Balanced", {
      components: [
        {
          category: "gpu",
          product_id: "gpu-id-1",
          name: "Sapphire RX 7700 XT",
          price: 42000,
          currency: "INR"
        }
      ],
      total: 42000,
      subtotal: 42000,
      is_complete: true,
      component_count: 1,
      unpriced_count: 0
    });
    const secondValidation = finishedValidation("v2", "Balanced", {
      components: [
        {
          category: "gpu",
          product_id: "gpu-id-2",
          name: "GeForce RTX 4060 Ti",
          price: 37000,
          currency: "INR"
        }
      ],
      total: 37000,
      subtotal: 37000,
      is_complete: true,
      component_count: 1,
      unpriced_count: 0
    });

    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          firstValidation,
          secondValidation,
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              builds: [
                {
                  label: "Balanced",
                  // The older of the two validations.
                  product_ids: ["gpu-id-1"]
                }
              ]
            }
          } as unknown as ChatUIMessage["parts"][number]
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");
    expect(versions).toHaveLength(1);

    const build = versions[0].builds[0];
    // The first label match would have been the 4060 Ti; the parts rule it out.
    expect(build.components[0].name).toBe("Sapphire RX 7700 XT");
    expect(build.total).toBe(42000);
  });
});

describe("version selection follows the newest build, by stable id", () => {
  const firstTurn: ChatUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-present_build",
          toolCallId: "call-1",
          state: "output-available",
          input: {
            builds: [
              {
                label: "First Build",
                parts: [
                  { category: "gpu", name: "RTX 4060", price: 28500, currency: "INR" },
                  { category: "cpu", name: "Ryzen 5 5600", price: 11200, currency: "INR" }
                ]
              }
            ]
          }
        } as unknown as ChatUIMessage["parts"][number]
      ]
    }
  ];

  const secondTurn: ChatUIMessage[] = [
    ...firstTurn,
    { id: "u2", role: "user", parts: [{ type: "text", text: "Now with AM5" }] },
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
                label: "Second Build",
                parts: [
                  { category: "gpu", name: "RTX 4070", price: 54000, currency: "INR" },
                  { category: "cpu", name: "Ryzen 5 7600", price: 18500, currency: "INR" }
                ]
              }
            ]
          }
        } as unknown as ChatUIMessage["parts"][number]
      ]
    }
  ];

  it("moves the selection to the new version instead of staying on the old one", () => {
    const before = findAllBuildVersions(firstTurn, "INR");
    expect(before).toHaveLength(1);
    const oldSelection = before[0].id;

    const after = findAllBuildVersions(secondTurn, "INR");
    expect(after).toHaveLength(2);

    // A new version arrived: the selection moves to it, by its stable id.
    const nextSelection = followNewestVersion(oldSelection, before[0].id, after);
    expect(nextSelection).toBe(after[1].id);
    expect(nextSelection).not.toBe(oldSelection);
    expect(resolveSelectedVersion(after, nextSelection)?.builds[0].label).toBe("Second Build");

    // Nothing new arrived: the selection is left exactly where it was.
    expect(followNewestVersion(oldSelection, after[1].id, after)).toBe(oldSelection);

    // And the card renders the newly selected build.
    const markup = renderToStaticMarkup(
      <BuildCard versions={after} selectedVersionId={nextSelection} inSidePanel />
    );
    expect(markup).toContain("Second Build");
    expect(markup).toContain("₹72,500");
    expect(markup).not.toContain("First Build");
  });

  it("falls back to the newest version when the selected one is gone", () => {
    const before = findAllBuildVersions(firstTurn, "INR");
    const after = findAllBuildVersions(secondTurn, "INR");

    // Nothing selected means the newest version.
    expect(resolveSelectedVersion(after, undefined)).toBe(after[1]);

    // Editing a message truncates the transcript, so the selected id can stop
    // naming anything: the panel falls back to a real build rather than nothing.
    expect(resolveSelectedVersion(before, after[1].id)).toBe(before[0]);
    expect(resolveSelectedVersion([], after[1].id)).toBeUndefined();
  });
});

describe("a malformed saved build cannot take the chat down", () => {
  /**
   * React's server renderer rethrows instead of handing an error to a boundary,
   * and this repo has no DOM environment to mount into, so drive the boundary's
   * own contract: render the children, and if they throw, apply the state that
   * getDerivedStateFromError produced and render the boundary's error branch.
   */
  function renderThroughBoundary(children: ReactNode, resetKeys: unknown[] = []): string {
    const instance = new BuildErrorBoundary({ children, resetKeys });
    try {
      return renderToStaticMarkup(<>{children}</>);
    } catch (error) {
      const state = BuildErrorBoundary.getDerivedStateFromError(error as Error);
      (instance as unknown as { state: typeof state }).state = state;
      return renderToStaticMarkup(instance.render());
    }
  }

  it("renders the boundary message instead of crashing on an unrenderable part", () => {
    // A retailer that came back as an object rather than a string: nothing in
    // the derive step can turn that back into a label.
    const malformed: DerivedBuild = {
      label: "Corrupt Build",
      currency: "INR",
      validation: null,
      isLegacy: false,
      components: [
        {
          category: "gpu",
          categoryLabel: "GPU",
          name: "RTX 4060",
          price: 28500,
          currency: "INR",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shape is the point
          retailer: { nested: "not a string" } as any,
          unverified: false,
          status: "ok"
        }
      ]
    };

    // Unguarded, the card throws while drawing that field.
    expect(() => renderToStaticMarkup(<BuildCard builds={[malformed]} inSidePanel />)).toThrow();

    const markup = renderThroughBoundary(<BuildCard builds={[malformed]} inSidePanel />);
    expect(decodeEntities(markup)).toContain("Couldn't display this build");
    expect(markup).toContain('role="alert"');
  });

  it("renders a build whose saved fields are the wrong shape", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "v1",
            state: "output-available",
            input: { label: "Odd Build", parts: { ram: RAM_ID } },
            output: {
              valid: false,
              // An issue saved without its components list at all.
              issues: [{ severity: "blocking", rule: "ddr", detail: "DDR5 required" }],
              resolved: {},
              summary: { passed: 0, failed: 1, unverified: 0, text: "1 check failed" },
              snapshot: {
                label: "Odd Build",
                components: [
                  // Null category, and the product id reused as the name.
                  { category: null, product_id: RAM_ID, name: RAM_ID, price: null, currency: "INR" }
                ],
                total: null,
                subtotal: 0,
                currency: "INR",
                is_complete: false,
                component_count: 1,
                unpriced_count: 1,
                missing_prices: [],
                currencies: [],
                parts: {},
                valid: false,
                created_at: "2026-01-01T00:00:00.000Z"
              }
            }
          } as unknown as ChatUIMessage["parts"][number],
          {
            type: "tool-present_build",
            toolCallId: "call-1",
            state: "output-available",
            input: { builds: [{ label: "Odd Build", product_ids: [RAM_ID] }] }
          } as unknown as ChatUIMessage["parts"][number]
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");
    expect(versions).toHaveLength(1);

    const build = versions[0].builds[0];
    // The null category does not throw, and the raw id is not the name.
    expect(build.components[0].name).not.toBe(RAM_ID);
    expect(build.total).toBeNull();

    const markup = renderThroughBoundary(<BuildCard versions={versions} inSidePanel />);
    expect(markup).toContain("Odd Build");
    expect(markup).not.toContain("Couldn't display this build");
    expect(markup).not.toContain("₹0.00");
  });

  it("recovers once the reset keys change, and leaves a healthy build alone", () => {
    const healthy = renderToStaticMarkup(
      <BuildErrorBoundary>
        <p>healthy build</p>
      </BuildErrorBoundary>
    );
    expect(healthy).toContain("healthy build");
    expect(decodeEntities(healthy)).not.toContain("Couldn't display this build");

    const props = { children: <p>build</p>, resetKeys: ["1:present:call-1"] };
    const instance = new BuildErrorBoundary(props);
    (instance as unknown as { state: { error: Error | null } }).state = {
      error: new Error("boom")
    };
    const setState = vi.fn();
    (instance as unknown as { setState: unknown }).setState = setState;

    // Same build: stay broken rather than thrashing on every render.
    instance.componentDidUpdate(props);
    expect(setState).not.toHaveBeenCalled();

    // A different build was selected: try again.
    instance.componentDidUpdate({ ...props, resetKeys: ["3:present:call-2"] });
    expect(setState).toHaveBeenCalledWith({ error: null });
  });
});

/** True when every transcript here has the same number of messages. */
function messagesCountIsStable(...transcripts: ChatUIMessage[][]): boolean {
  return transcripts.every((messages) => messages.length === transcripts[0].length);
}

/** SSR escapes an apostrophe as &#x27;; assertions read better without it. */
function decodeEntities(markup: string): string {
  return markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

/** A session whose only build lives in the assistant's prose: no present_build, no validate_build. */
const markdownOnlySession: ChatUIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Just tell me a build in a table." }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: [
          "Here is a build:",
          "",
          "| Component | Part | Price |",
          "|---|---|---|",
          "| GPU | RTX 4060 | ₹29,000 |",
          "| CPU | AMD Ryzen 5 5600 | ₹11,500 |"
        ].join("\n")
      }
    ]
  }
];

describe("R-A1: the header effect cannot re-arm itself", () => {
  it("fingerprints a markdown build identically on every derive pass", () => {
    // Two independent passes over the same transcript: the objects differ, which
    // is exactly what re-armed the header effect until React gave up.
    const first = findAllBuildVersions(markdownOnlySession, "INR");
    const second = findAllBuildVersions(markdownOnlySession, "INR");

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].builds).not.toBe(first[0].builds);
    expect(second[0].builds[0]).not.toBe(first[0].builds[0]);
    expect(second[0].builds[0].components[0]).not.toBe(first[0].builds[0].components[0]);

    // ...while the value it renders is identical, so the effect sees no change.
    expect(buildsFingerprint(second[0].builds)).toBe(buildsFingerprint(first[0].builds));

    const header = {
      sessionId: "s1",
      model: "gemini-2.5-flash",
      streaming: false,
      compacting: false,
      sidePanelOpen: true,
      messageCount: 2,
      transcript: JSON.stringify(markdownOnlySession),
      error: "",
      currency: "INR",
      countryCode: "IN",
      buildPrice: "₹40,500",
      builds: first[0].builds
    };
    expect(buildHeaderSignature({ ...header, builds: second[0].builds })).toBe(
      buildHeaderSignature(header)
    );

    // A build that really changed still moves the signature.
    expect(buildHeaderSignature({ ...header, builds: undefined })).not.toBe(
      buildHeaderSignature(header)
    );
  });

  it("moves the header signature when a streamed reply changes", () => {
    // The header closes over `messages`: the transcript menu copies and
    // downloads them. Keyed on the message count alone, the export went out
    // missing the whole reply, because the count only changes when the message
    // is first appended.
    const beforeStream = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "" }] }
    ] as unknown as ChatUIMessage[];
    const midStream = [
      beforeStream[0],
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Starting with the " }] }
    ] as unknown as ChatUIMessage[];
    const afterStream = [
      beforeStream[0],
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Starting with the GPU." }] }
    ] as unknown as ChatUIMessage[];

    const header = {
      sessionId: "s1",
      model: "gemini-2.5-flash",
      streaming: true,
      compacting: false,
      sidePanelOpen: false,
      currency: "INR",
      countryCode: "IN",
      error: "",
      buildPrice: null,
      builds: null
    };
    const signatureFor = (messages: ChatUIMessage[]) =>
      buildHeaderSignature({
        ...header,
        messageCount: messages.length,
        transcript: sessionSignature(messages)
      });

    // Same message count throughout: only the content differs.
    expect(messagesCountIsStable(beforeStream, midStream, afterStream)).toBe(true);
    expect(signatureFor(midStream)).not.toBe(signatureFor(beforeStream));
    expect(signatureFor(afterStream)).not.toBe(signatureFor(midStream));
  });

  it("shows the markdown build in the panel", () => {
    const versions = findAllBuildVersions(markdownOnlySession, "INR");
    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    expect(markup).toContain("RTX 4060");
    expect(markup).toContain("₹40,500");
  });
});

describe("R-A2: a build parsed out of the assistant's text says so", () => {
  it("labels it instead of offering it as a normal version", () => {
    const versions = findAllBuildVersions(markdownOnlySession, "INR");

    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe("Not validated — from the assistant's text");
    expect(versions[0].label).not.toMatch(/^Version \d+$/);
    expect(versions[0].builds[0].textDerived).toBe(true);

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    expect(decodeEntities(markup)).toContain("Not validated — from the assistant's text");
    // Never validated means never "ok": no component claims it was checked.
    expect(markup).toContain("Unverified compatibility");
    expect(markup).not.toContain("checks passed");

    // The version picker must not dress it up as "Version 1".
    const twoVersions = findAllBuildVersions(
      [
        ...markdownOnlySession,
        { id: "u2", role: "user", parts: [{ type: "text", text: "and now with an M2?" }] },
        {
          id: "a2",
          role: "assistant",
          parts: [
            {
              type: "tool-present_build",
              toolCallId: "call-1",
              state: "output-available",
              input: {
                builds: [
                  {
                    label: "Real Build",
                    parts: [
                      { category: "gpu", name: "RTX 4070", price: 54000, currency: "INR" }
                    ]
                  }
                ]
              }
            } as unknown as ChatUIMessage["parts"][number]
          ]
        }
      ],
      "INR"
    );
    const picker = renderToStaticMarkup(
      <BuildCard versions={twoVersions} selectedVersionId={twoVersions[1].id} inSidePanel />
    );
    expect(picker).toContain("Version 2 (Latest)");
    expect(decodeEntities(picker)).toContain("Not validated — from the assistant's text");
  });

  it("surfaces a blocking issue from the same turn without claiming validation", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build." }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "v1",
            state: "output-available",
            input: { label: "Rejected", parts: { cpu: "ryzen-5-7600", ram: "ddr4-16" } },
            output: {
              valid: false,
              issues: [
                {
                  severity: "blocking",
                  rule: "ddr",
                  components: ["ram", "cpu"],
                  detail: "AM5 CPUs require DDR5 memory, but DDR4 was selected."
                }
              ],
              resolved: {},
              checks: []
            }
          } as unknown as ChatUIMessage["parts"][number],
          {
            type: "text",
            text: [
              "How about this:",
              "",
              "| Component | Part | Price |",
              "|---|---|---|",
              "| CPU | Ryzen 5 7600 | ₹18,500 |",
              "| RAM | DDR4 16GB | ₹3,500 |"
            ].join("\n")
          }
        ]
      }
    ];

    const versions = findAllBuildVersions(messages, "INR");
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe("Not validated — from the assistant's text");

    const build = versions[0].builds[0];
    expect(build.textDerived).toBe(true);
    const ram = build.components.find((c) => c.category === "ram");
    expect(ram?.failed).toBe(true);
    expect(ram?.failedNote).toContain("DDR5");

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    // The caveat and the blocking issue coexist.
    expect(decodeEntities(markup)).toContain("Not validated — from the assistant's text");
    expect(markup).toContain("AM5 CPUs require DDR5 memory");
    expect(markup).toContain("1 check failed");
    // No check ever passed on a text build, and none may be claimed. The strip
    // always prints an "N passed" clause, so the honest reading is the zero.
    expect(markup).toContain("0 passed");
    expect(markup).not.toMatch(/[1-9]\d* passed/);
  });
});

describe("R-A3: the thinking trace stops pulsing once the message is done", () => {
  const reasoningMessage = (state: string): ChatUIMessage => ({
    id: "a1",
    role: "assistant",
    parts: [
      { type: "reasoning", state, text: "Comparing catalog options." }
    ] as unknown as ChatUIMessage["parts"]
  });

  it("animates a live reasoning part and not a finished one", () => {
    const live = renderToStaticMarkup(<MessageView message={reasoningMessage("streaming")} currency="INR" />);
    expect(live).toContain("animate-pulse");
    expect(live).toContain("Sage thinking process...");
    expect(live).toContain('aria-busy="true"');

    const done = renderToStaticMarkup(<MessageView message={reasoningMessage("done")} currency="INR" />);
    expect(done).not.toContain("animate-pulse");
    // The trace and its name are still there - it just is not busy any more.
    expect(done).toContain("Sage thinking process...");
    expect(done).toContain('aria-busy="false"');
  });
});

describe("R-A4: a session switch cannot leave the previous chat's build on screen", () => {
  it("drops the opened builds when the session id changes", () => {
    const [versionA] = findAllBuildVersions(secondTurnForPanel(), "INR");
    expect(versionA).toBeDefined();

    const opened = { sessionId: "session-a", builds: versionA.builds };

    // Still the same session: the panel keeps what was opened.
    expect(openedBuildsForSession(opened, "session-a")).toBe(versionA.builds);

    // Session B is on screen and has no builds of its own.
    expect(openedBuildsForSession(opened, "session-b")).toBeNull();
    expect(openedBuildsForSession(null, "session-b")).toBeNull();

    // So the panel has nothing to fall back to: no stale build, and no price.
    const displayBuilds = openedBuildsForSession(opened, "session-b");
    expect(displayBuilds).toBeNull();
    expect(buildsFingerprint(displayBuilds)).toBe("");
  });
});

/** A single turn that presents a build, reused by the session-switch test. */
function secondTurnForPanel(): ChatUIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Propose a build" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-present_build",
          toolCallId: "call-1",
          state: "output-available",
          input: {
            builds: [
              {
                label: "Session A Build",
                parts: [
                  { category: "gpu", name: "RTX 4060", price: 28500, currency: "INR" }
                ]
              }
            ]
          }
        } as unknown as ChatUIMessage["parts"][number]
      ]
    }
  ];
}
