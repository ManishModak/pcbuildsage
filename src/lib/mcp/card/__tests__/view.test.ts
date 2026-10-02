/**
 * src/lib/mcp/card/__tests__/view.test.ts
 *
 * Render tests for the MCP build card. They execute the exact CARD_SCRIPT
 * string served inside the card HTML (via `new Function`), so the tests run
 * the shipped view logic rather than a copy of it.
 */
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildCardHtml } from "../../build-card";
import { CARD_BOOT_SCRIPT, CARD_SCRIPT, type McpCardView } from "../view";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-02T12:00:00Z").getTime();

type SnapshotComponent = {
  category: string;
  name: string;
  price: number | null;
  currency: string;
  retailer?: string;
  url?: string;
  observed_at?: string;
  included?: boolean;
};

function component(overrides: Partial<SnapshotComponent> & { name: string }): SnapshotComponent {
  return {
    category: "cpu",
    price: 8500,
    currency: "INR",
    retailer: "PrimeABGB",
    url: "https://example.com/cpu",
    observed_at: new Date(NOW - 3 * DAY_MS).toISOString(),
    ...overrides
  };
}

function card(label: string, snapshot: Record<string, unknown>) {
  return { label, snapshot };
}

function inrSnapshot(components: SnapshotComponent[]) {
  return {
    components,
    total: 26500,
    currency: "INR",
    validation_summary: { passed: 6, failed: 0, unverified: 1, skipped: 0, issues: [] }
  };
}

/** Loads the real card script against a fresh happy-dom document. */
function loadCard() {
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = '<div id="root"></div>';
  const run = new Function("document", `${CARD_SCRIPT}\nreturn PCBuildSageCard;`) as (
    doc: Document
  ) => McpCardView;
  const view = run(document as unknown as Document);
  const root = document.getElementById("root") as unknown as Element;
  return { document, root, view, window };
}

function mountWithCards(
  cards: unknown,
  openLink: (url: string) => void = () => {}
) {
  const loaded = loadCard();
  const api = loaded.view.mount(loaded.root, { openLink });
  api.onToolResult({ structuredContent: { cards } });
  return { ...loaded, api };
}

function click(element: Element, window: Window) {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  (element as unknown as { dispatchEvent(event: object): void }).dispatchEvent(event);
}

describe("build card view", () => {
  it("renders a single build with no tabs", () => {
    const { root } = mountWithCards([
      card("Budget 1080p", inrSnapshot([component({ name: "Ryzen 5 5600" })]))
    ]);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.innerHTML).toContain("Budget 1080p");
    expect(root.innerHTML).toContain("Ryzen 5 5600");
    expect(root.innerHTML).toContain("PrimeABGB");
    expect(root.innerHTML).toContain("6 checks passed");
  });

  it("formats INR prices without decimals", () => {
    const { root } = mountWithCards([
      card("Budget 1080p", inrSnapshot([component({ name: "Ryzen 5 5600", price: 8500 })]))
    ]);
    expect(root.innerHTML).toContain("₹8,500");
  });

  it("formats a USD build in dollars", () => {
    const { root } = mountWithCards([
      card("US build", {
        components: [
          {
            category: "gpu",
            name: "RX 7600",
            price: 1299.5,
            currency: "USD",
            retailer: "Newegg",
            url: "https://example.com/gpu",
            observed_at: new Date(NOW - DAY_MS).toISOString()
          }
        ],
        total: 1299.5,
        currency: "USD",
        validation_summary: { passed: 6, failed: 0, unverified: 0, skipped: 0, issues: [] }
      })
    ]);
    expect(root.innerHTML).toContain("$1,299.50");
  });

  it("renders pill tabs for multiple builds and switches on click", () => {
    const { root, window } = mountWithCards([
      card("Value", inrSnapshot([component({ name: "Ryzen 5 5600" })])),
      card("Stretch", inrSnapshot([component({ name: "Ryzen 7 5700X" })]))
    ]);
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Value", "Stretch"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(root.innerHTML).toContain("Ryzen 5 5600");
    expect(root.innerHTML).not.toContain("Ryzen 7 5700X");

    click(tabs[1], window);
    const reselected = [...root.querySelectorAll('[role="tab"]')];
    expect(reselected[1].getAttribute("aria-selected")).toBe("true");
    expect(reselected[0].getAttribute("aria-selected")).toBe("false");
    expect(root.innerHTML).toContain("Ryzen 7 5700X");
    expect(root.innerHTML).not.toContain("Ryzen 5 5600");
  });

  it("disambiguates two builds that share a label", () => {
    const { root, window } = mountWithCards([
      card("Same", inrSnapshot([component({ name: "Part A" })])),
      card("Same", inrSnapshot([component({ name: "Part B" })]))
    ]);
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Same", "Same · 2"]);
    click(tabs[1], window);
    expect(root.innerHTML).toContain("Part B");
  });

  it("shows 'total incomplete' when the snapshot total is null", () => {
    const { root } = mountWithCards([
      card("Partial", {
        ...inrSnapshot([component({ name: "Ryzen 5 5600", price: null })]),
        total: null
      })
    ]);
    expect(root.innerHTML).toContain("total incomplete");
    expect(root.innerHTML).toContain("price unknown");
  });

  it("renders included parts without a buy link", () => {
    const { root } = mountWithCards([
      card("Stock cooler", {
        ...inrSnapshot([
          component({
            category: "cooler",
            name: "Stock Cooler (Included with CPU)",
            price: 0,
            retailer: undefined,
            url: undefined,
            included: true
          })
        ]),
        total: null
      })
    ]);
    expect(root.innerHTML).toContain("included");
    expect(root.querySelector("a[data-url]")).toBeNull();
  });

  it("lists advisories and check counts", () => {
    const { root } = mountWithCards([
      card("Advisory build", {
        components: [component({ name: "Tall cooler" })],
        total: 26500,
        currency: "INR",
        validation_summary: {
          passed: 5,
          failed: 0,
          unverified: 2,
          skipped: 1,
          issues: ["Cooler clearance is advisory: verify case fit"]
        }
      })
    ]);
    expect(root.innerHTML).toContain("5 checks passed, 2 unverified, 1 skipped");
    expect(root.innerHTML).toContain("Cooler clearance is advisory: verify case fit");
  });

  it("shows price age from observed_at", () => {
    const { view } = loadCard();
    expect(
      view.priceAgeLabel(
        [{ price: 10, observed_at: new Date(NOW - 3 * DAY_MS).toISOString() }],
        NOW
      )
    ).toBe("prices checked 3 days ago");
    expect(
      view.priceAgeLabel(
        [{ price: 10, observed_at: new Date(NOW).toISOString() }],
        NOW
      )
    ).toBe("prices checked today");
    expect(view.priceAgeLabel([{ price: 10 }], NOW)).toBe("");

    const { root } = mountWithCards(
      [
        card(
          "Budget 1080p",
          inrSnapshot([component({ name: "Ryzen 5 5600" })])
        )
      ]
    );
    expect(root.querySelector(".age")).not.toBeNull();
  });

  it("routes buy-link clicks through openLink", () => {
    const opened: string[] = [];
    const { root, window } = mountWithCards(
      [card("Budget 1080p", inrSnapshot([component({ name: "Ryzen 5 5600" })]))],
      (url) => {
        opened.push(url);
      }
    );
    const link = root.querySelector('a[data-url="https://example.com/cpu"]');
    expect(link).not.toBeNull();
    click(link!, window);
    expect(opened).toEqual(["https://example.com/cpu"]);
  });

  it("applies the host theme and ignores invalid values", () => {
    const { document, api } = mountWithCards([
      card("Budget 1080p", inrSnapshot([component({ name: "Ryzen 5 5600" })]))
    ]);
    api.setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    api.setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    api.setTheme("banana");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("says so when there is no build to show", () => {
    const { root } = mountWithCards([]);
    expect(root.innerHTML).toContain("No build to show.");
  });
});

describe("build card wiring", () => {
  it("follows the host theme and reports height", () => {
    expect(CARD_BOOT_SCRIPT).toContain("app.onhostcontextchanged");
    expect(CARD_BOOT_SCRIPT).toContain("app.getHostContext");
    expect(CARD_BOOT_SCRIPT).toContain("prefers-color-scheme");
    expect(CARD_BOOT_SCRIPT).toContain("autoResize: true");
    expect(CARD_BOOT_SCRIPT).toContain("app.ontoolresult");
    expect(CARD_BOOT_SCRIPT).toContain("app.openLink");
  });

  it("serves the view with the ext-apps bundle binding", () => {
    const html = buildCardHtml();
    expect(html).toContain("const __extApps={");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("onhostcontextchanged");
    expect(html).toContain("data-theme");
    // One inline module script: no view string may contain a closing tag.
    expect(html.match(/<\/script/gi)).toHaveLength(1);
  });
});
