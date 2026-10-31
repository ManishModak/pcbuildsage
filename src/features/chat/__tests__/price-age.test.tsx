import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derivedBuildFromSnapshot, priceAge, recheckPricesPrompt } from "../build-derive";
import { BuildCard } from "../build-card";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");

function snapshot(observed: Array<string | undefined>, label?: string): BuildSnapshot {
  return {
    label,
    currency: "INR",
    total: 40000,
    components: observed.map((observed_at, i) => ({
      category: i === 0 ? "gpu" : "cpu",
      name: `Part ${i}`,
      price: 20000,
      currency: "INR",
      retailer: "MDComputers",
      observed_at
    }))
  } as BuildSnapshot;
}

describe("build price age", () => {
  it("dates a build by its oldest priced part", () => {
    const build = derivedBuildFromSnapshot(
      snapshot(["2026-10-09T08:00:00Z", "2026-09-28T08:46:57Z", "not a date"]),
      null
    );
    expect(build.pricesAsOf).toBe("2026-09-28T08:46:57Z");
  });

  it("leaves builds without scrape times undated", () => {
    expect(derivedBuildFromSnapshot(snapshot([undefined]), null).pricesAsOf).toBeUndefined();
    expect(priceAge(undefined, NOW)).toBeNull();
  });

  it("calls prices stale from seven days", () => {
    expect(priceAge(new Date(NOW - 6 * DAY).toISOString(), NOW)?.stale).toBe(false);
    expect(priceAge(new Date(NOW - 7 * DAY).toISOString(), NOW)).toEqual({
      label: "Prices are 7 days old",
      stale: true
    });
  });

  it("names the build in the recheck message when it has a label", () => {
    expect(recheckPricesPrompt({ label: "1440p Value" })).toBe(
      'Recheck current prices and stock for the "1440p Value" build.'
    );
    expect(recheckPricesPrompt({})).toBe("Recheck current prices and stock for this build.");
  });

  it("offers a recheck only for stale prices and when a handler is given", () => {
    const stale = derivedBuildFromSnapshot(snapshot(["2026-01-01T00:00:00Z"]), null);
    const fresh = derivedBuildFromSnapshot(snapshot([new Date().toISOString()]), null);
    const noop = () => {};

    expect(renderToStaticMarkup(<BuildCard builds={[stale]} onRecheckPrices={noop} />)).toContain("recheck prices");
    // Mid-reply the handler is withheld: the note stays, the button goes.
    const streaming = renderToStaticMarkup(<BuildCard builds={[stale]} />);
    expect(streaming).toMatch(/Prices are \d+ days old/);
    expect(streaming).not.toContain("<button");
    const freshHtml = renderToStaticMarkup(<BuildCard builds={[fresh]} onRecheckPrices={noop} />);
    expect(freshHtml).toContain("Prices as of");
    expect(freshHtml).not.toContain("recheck prices");
  });
});
