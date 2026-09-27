import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAllBuildVersions, VALIDATED_VERSION_LABEL } from "../build-versions";
import { BuildCard } from "../build-card";
import { MessageView, type ChatUIMessage } from "../message";

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

    // Four finished validations exist, and none of them was ever presented.
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe(VALIDATED_VERSION_LABEL);
    expect(versions[0].label).toBe("Validated — not presented yet");
    expect(versions[0].presentationId).toBeUndefined();
    expect(versions[0].id).toBe("3:validated:xcW55TuwFySPUsFqzPnBKZlTj78i5xpK");

    const build = versions[0].builds[0];
    expect(build.label).toBe("Integrated-Graphics Competitive (3400G APU)");
    expect(build.currency).toBe("INR");
    expect(build.total).toBeNull();
    expect(build.components).toHaveLength(6);

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);

    // Not blank: the parts the rules engine actually resolved are on screen.
    expect(markup).toContain("ASRock A520M-HVS M-ATX Motherboard");
    expect(markup).toContain("EVM 512GB NVMe Gen3 SSD");
    expect(markup).toContain("₹4,900");

    // A product id is never a part name: the unresolved RAM falls back to its
    // category label, and the id stays out of the name slot.
    expect(markup).not.toContain(RAM_ID);
    expect(markup).toContain("Memory");

    // An incomplete snapshot has no total, and that reads as an em dash.
    expect(markup).toContain("—");
    expect(markup).not.toContain("₹0.00");
  });

  it("shows the validated builds in the message's own build button", () => {
    const versions = findAllBuildVersions(stuckSession, "INR");
    const markup = renderToStaticMarkup(
      <MessageView message={stuckSession[3]} versions={versions} currency="INR" />
    );

    expect(markup).toContain("Validated — not presented yet");
    expect(markup).toContain("Integrated-Graphics Competitive (3400G APU)");
    expect(markup).toContain('aria-label="View proposed build: Integrated-Graphics Competitive (3400G APU)"');
    // The button must not advertise a total it does not have.
    expect(markup).not.toContain("₹0.00");
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
