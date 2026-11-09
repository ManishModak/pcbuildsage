import { describe, expect, it } from "vitest";
import { createPresentBuildTool, presentableLabels } from "../present-build";
import { createTurnValidationStore, recordValidation } from "../turn-state";

const ctx = { toolCallId: "t", messages: [] } as never;
const CPU = "da6670a41d06377759be1c70e28f32230239c099";

function validation(valid: boolean) {
  return {
    valid,
    issues: valid ? [] : [{ severity: "blocking", rule: "socket", detail: "CPU socket AM4 does not match motherboard socket AM5." }],
    snapshot: { label: "x", components: [{ category: "cpu", product_id: CPU }] }
  } as never;
}

function storeWith(entries: Record<string, boolean>) {
  const store = createTurnValidationStore();
  for (const [label, valid] of Object.entries(entries)) recordValidation(store, label, validation(valid));
  return store;
}

type Out = { presented: boolean; error?: string; builds?: Array<{ label: string }>; not_presented?: Array<{ label: string; error: string }> };

describe("present_build leniency", () => {
  it("presents the valid builds of a call and lists the refused ones", async () => {
    const present = createPresentBuildTool(storeWith({ "AM5 DDR5 Build": true, "AM4 DDR4 Build": false }));
    const out = (await present.execute!({ builds: [{ label: "AM5 DDR5 Build" }, { label: "AM4 DDR4 Build" }] }, ctx)) as Out;
    expect(out.presented).toBe(true);
    expect(out.builds?.map((b) => b.label)).toEqual(["AM5 DDR5 Build"]);
    expect(out.not_presented).toEqual([{ label: "AM4 DDR4 Build", error: expect.stringContaining("blocking compatibility issues") }]);
  });

  it("refuses as before when nothing in the call is presentable", async () => {
    const present = createPresentBuildTool(storeWith({ "AM4 DDR4 Build": false }));
    const out = (await present.execute!({ builds: [{ label: "AM4 DDR4 Build" }] }, ctx)) as Out;
    expect(out.presented).toBe(false);
    expect(out.error).toContain("blocking compatibility issues");
    expect(out).not.toHaveProperty("presentable_labels");
  });

  it("shows a build labelled within budget but validated over the budget under an honest label", async () => {
    const store = createTurnValidationStore();
    const over = {
      ...(validation(true) as object),
      snapshot: { label: "x", currency: "INR", components: [{ category: "cpu", product_id: CPU }] },
      budget: { target: 35000, total: 35577, over_by: 577, under_by: 0 }
    } as never;
    recordValidation(store, "Within budget", over);
    recordValidation(store, "Small upgrade", over);
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Within budget" }, { label: "Small upgrade" }] }, ctx)) as Omit<Out, "builds"> & {
      builds?: Array<{ label: string; validated_label?: string }>;
      label_note?: string;
    };
    expect(out.builds?.map((b) => [b.label, b.validated_label])).toEqual([
      ["Closest to budget (₹577 over)", "Within budget"],
      ["Small upgrade", undefined]
    ]);
    expect(out.label_note).toContain("'Within budget' as 'Closest to budget (₹577 over)'");
  });

  it("names the builds ready to present when a call asks only for others", async () => {
    const present = createPresentBuildTool(storeWith({ "Cheapest": false, "GPU build": true }));
    const out = (await present.execute!({ builds: [{ label: "Cheapest" }, { label: "RX 580 build" }] }, ctx)) as Out & { presentable_labels?: string[] };
    expect(out.presented).toBe(false);
    expect(out.error).toContain("Ready to present now: GPU build.");
    expect(out.presentable_labels).toEqual(["GPU build"]);
  });

  it("finds a validated label the presented label starts with as whole words", async () => {
    const present = createPresentBuildTool(storeWith({ "AM5 DDR5 Build": true, "AM5": true }));
    const out = (await present.execute!({ builds: [{ label: "AM5 DDR5 Build (Recommended, over budget)" }] }, ctx)) as Out;
    expect(out.builds?.map((b) => b.label)).toEqual(["AM5 DDR5 Build"]);
    // "AM5 DDR5 Builder" is not "AM5 DDR5 Build" plus words; only the shorter whole-word "AM5" matches.
    const partial = (await present.execute!({ builds: [{ label: "AM5 DDR5 Builder" }] }, ctx)) as Out;
    expect(partial.builds?.map((b) => b.label)).toEqual(["AM5"]);
  });

  it("fills an empty call with every presentable build validated this turn", async () => {
    const store = storeWith({ "AM5 DDR5 Build": true, "AM4 DDR4 Build": false, "Small upgrade": true });
    expect(presentableLabels(store)).toEqual(["AM5 DDR5 Build", "Small upgrade"]);
    const present = createPresentBuildTool(store);
    const schema = present.inputSchema as unknown as { validate: (v: unknown) => Promise<{ success: boolean; value?: unknown }> };
    const parsed = await schema.validate({});
    expect(parsed).toMatchObject({ success: true, value: { builds: [{ label: "AM5 DDR5 Build" }, { label: "Small upgrade" }] } });
    // Nothing presentable: the empty call still fails validation.
    const none = createPresentBuildTool(storeWith({ "AM4 DDR4 Build": false }));
    expect((await (none.inputSchema as unknown as typeof schema).validate({})).success).toBe(false);
  });
});
