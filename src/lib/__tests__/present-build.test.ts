import { describe, expect, it } from "vitest";
import { createPresentBuildTool, presentBuildInputSchema } from "../tools/present-build";
import {
  deriveBuilds,
  extractBuildsFromMessage,
  parseBuildsFromMarkdown
} from "@/features/chat/build-derive";
import type { ToolPart } from "@/features/chat/tool-chip";

describe("present_build tool", () => {
  it("validates structured input with builds and product_ids references", () => {
    const valid = presentBuildInputSchema.safeParse({
      builds: [
        {
          label: "Max Performance",
          product_ids: ["in-gpu-5060-01", "in-cpu-5600x-01"],
          notes: "Focuses on raw GPU horsepower."
        }
      ]
    });
    expect(valid.success).toBe(true);
  });

  it("executes and returns presented confirmation and build count", async () => {
    const tool = createPresentBuildTool();
    const input = {
      builds: [
        {
          label: "Max Performance",
          product_ids: ["in-gpu-5060-01"]
        },
        {
          label: "Value Gaming",
          product_ids: ["in-gpu-5050-01"]
        }
      ]
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await tool.execute!(input, { toolCallId: "test-call", messages: [] } as any);
    expect(result).toEqual({
      presented: true,
      buildCount: 2,
      builds: input.builds
    });
  });
});

describe("markdown table and text build extraction resilience", () => {
  it("extracts structured build from markdown table with prices, retailers, and links", () => {
    const markdown = `
Here is your proposed gaming build:

| Component | Part | Price | Retailer |
| :--- | :--- | :--- | :--- |
| GPU | [Nvidia RTX 5060 8GB](https://kryptronix.in/rtx5060) | ₹35,900 | Kryptronix |
| CPU | AMD Ryzen 5 7600 | ₹18,500 | Amazon |
| Motherboard | MSI B650M Gaming WiFi | ₹11,200 | MDComputers |
| RAM | 32GB (2x16GB) DDR5-6000 | ₹9,500 | PrimeABGB |
| Storage | 1TB NVMe SSD | ₹6,200 | Amazon |
| Power Supply | 650W 80+ Gold | ₹5,800 | Vedant |
| Case | Deepcool CC560 | ₹4,100 | MDComputers |
| Cooler | Deepcool AG400 | ₹1,900 | Amazon |
| **Total** | | **₹93,100** | |

This build will deliver excellent 1080p and 1440p gaming performance.
    `;

    const builds = parseBuildsFromMarkdown(markdown, "INR");
    expect(builds).toHaveLength(1);
    expect(builds[0].label).toBe("Proposed Build");
    expect(builds[0].currency).toBe("INR");
    expect(builds[0].components).toHaveLength(8);

    // Order verification (GPU -> CPU -> Motherboard -> RAM -> Storage -> PSU -> Case -> Cooler)
    expect(builds[0].components[0].category).toBe("gpu");
    expect(builds[0].components[0].name).toBe("Nvidia RTX 5060 8GB");
    expect(builds[0].components[0].price).toBe(35900);
    expect(builds[0].components[0].retailer).toBe("Kryptronix");
    expect(builds[0].components[0].url).toBe("https://kryptronix.in/rtx5060");

    expect(builds[0].components[1].category).toBe("cpu");
    expect(builds[0].components[1].name).toBe("AMD Ryzen 5 7600");
    expect(builds[0].components[1].price).toBe(18500);
    expect(builds[0].components[1].retailer).toBe("Amazon");

    expect(builds[0].components[2].category).toBe("motherboard");
    expect(builds[0].components[2].price).toBe(11200);

    // Total row should NOT be present in components list
    const totalComponent = builds[0].components.find((c) => c.name.toLowerCase().includes("total"));
    expect(totalComponent).toBeUndefined();
  });

  it("extracts multiple builds from markdown sections with distinct labels", () => {
    const markdown = `
### Option 1: Best Value (1080p Ultra)
| Component | Part | Price |
|---|---|---|
| GPU | RTX 4060 | ₹28,990 |
| CPU | Ryzen 5 5600 | ₹11,490 |
| Motherboard | B550M WiFi | ₹8,990 |

### Option 2: Performance Stretch (1440p Ready)
| Component | Part | Price |
|---|---|---|
| GPU | RTX 4070 Super | ₹58,990 |
| CPU | Ryzen 5 7600 | ₹18,500 |
| Motherboard | B650M Gaming | ₹11,200 |
    `;

    const builds = parseBuildsFromMarkdown(markdown, "INR");
    expect(builds).toHaveLength(2);
    expect(builds[0].label).toBe("Option 1: Best Value (1080p Ultra)");
    expect(builds[0].components).toHaveLength(3);
    expect(builds[0].components[0].price).toBe(28990);

    expect(builds[1].label).toBe("Option 2: Performance Stretch (1440p Ready)");
    expect(builds[1].components).toHaveLength(3);
    expect(builds[1].components[0].price).toBe(58990);
  });

  it("extracts builds from bulleted component lists", () => {
    const markdown = `
Here is your component list:
- **GPU:** MSI GeForce RTX 4060 8GB — ₹28,990 (Amazon)
- **CPU:** AMD Ryzen 5 5600 — ₹11,490 (PrimeABGB)
- **Motherboard:** MSI B550M PRO-VDH WiFi — ₹8,990
- **RAM:** Corsair Vengeance LPX 16GB DDR4 — ₹3,490
- **Storage:** Crucial P3 Plus 1TB NVMe SSD — ₹5,200
- **Power Supply:** Deepcool PK550D 550W — ₹3,350
- **Case:** Ant Esports ICE-100 — ₹2,800
- **Cooler:** Deepcool AG400 — ₹1,690
    `;

    const builds = parseBuildsFromMarkdown(markdown, "INR");
    expect(builds).toHaveLength(1);
    expect(builds[0].components).toHaveLength(8);
    expect(builds[0].components[0].category).toBe("gpu");
    expect(builds[0].components[0].name).toBe("MSI GeForce RTX 4060 8GB");
    expect(builds[0].components[0].price).toBe(28990);
    expect(builds[0].components[0].retailer).toBe("Amazon");

    expect(builds[0].components[1].category).toBe("cpu");
    expect(builds[0].components[1].name).toBe("AMD Ryzen 5 5600");
    expect(builds[0].components[1].price).toBe(11490);
    expect(builds[0].components[1].retailer).toBe("PrimeABGB");
  });

  it("prioritizes tool call builds when present_build tool part is present", () => {
    const toolParts: ToolPart[] = [
      {
        type: "tool-present_build",
        toolCallId: "call-1",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Tool Card Build",
              parts: [
                { category: "gpu", name: "RTX 5070", price: 65000, currency: "INR" },
                { category: "cpu", name: "Ryzen 7 7800X3D", price: 42000, currency: "INR" }
              ]
            }
          ]
        },
        output: { presented: true, buildCount: 1 }
      }
    ];

    const message = {
      role: "assistant",
      parts: [
        ...toolParts,
        {
          type: "text" as const,
          text: `
| Component | Part | Price |
|---|---|---|
| GPU | Old Table GPU | ₹20,000 |
| CPU | Old Table CPU | ₹10,000 |
          `
        }
      ]
    };

    const derived = extractBuildsFromMessage(message, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].label).toBe("Tool Card Build");
    expect(derived[0].components[0].name).toBe("RTX 5070");
    expect(derived[0].components[0].price).toBe(65000);
  });

  it("extracts build from text part when present_build tool call is absent", () => {
    const message = {
      role: "assistant",
      parts: [
        {
          type: "text" as const,
          text: `
| Component | Part | Price |
|---|---|---|
| GPU | Nvidia RTX 4060 | ₹29,000 |
| CPU | AMD Ryzen 5 5600 | ₹11,500 |
          `
        }
      ]
    };

    const derived = deriveBuilds(message.parts, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].components).toHaveLength(2);
    expect(derived[0].components[0].name).toBe("Nvidia RTX 4060");
    expect(derived[0].components[0].price).toBe(29000);
  });

  it("returns empty array when text does not contain valid PC build components", () => {
    const plainText = "Hello! How can I help you build your PC today? Let me know your budget.";
    const builds = parseBuildsFromMarkdown(plainText, "INR");
    expect(builds).toHaveLength(0);
  });

  it("derives multiple builds presented together with tradeoff labels", () => {
    const parts: ToolPart[] = [
      {
        type: "tool-present_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Within budget",
              parts: [
                { category: "cpu", name: "Ryzen 5 5600", price: 11500 },
                { category: "gpu", name: "RX 6600", price: 20000 }
              ]
            },
            {
              label: "Small upgrade",
              parts: [
                { category: "cpu", name: "Ryzen 5 5600X", price: 13000 },
                { category: "gpu", name: "RTX 4060", price: 28000 }
              ]
            }
          ]
        },
        output: { presented: true, buildCount: 2 }
      }
    ];

    const derived = deriveBuilds(parts, "INR");
    expect(derived).toHaveLength(2);
    expect(derived[0].label).toBe("Within budget");
    expect(derived[0].components).toHaveLength(2);
    expect(derived[0].components[0].name).toBe("RX 6600");
    expect(derived[0].components[0].price).toBe(20000);
    expect(derived[0].components[1].name).toBe("Ryzen 5 5600");
    expect(derived[0].components[1].price).toBe(11500);

    expect(derived[1].label).toBe("Small upgrade");
    expect(derived[1].components).toHaveLength(2);
    expect(derived[1].components[0].name).toBe("RTX 4060");
    expect(derived[1].components[0].price).toBe(28000);
    expect(derived[1].components[1].name).toBe("Ryzen 5 5600X");
    expect(derived[1].components[1].price).toBe(13000);
  });

  it("shows snapshot price when model present_build attempts to specify a differing price", () => {
    const parts: ToolPart[] = [
      {
        type: "tool-validate_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Challenger Build",
              parts: { gpu: { product_id: "in-gpu-4060" } }
            }
          ]
        },
        output: {
          builds: {
            "Challenger Build": {
              valid: true,
              resolved: {},
              issues: [],
              checks: [],
              snapshot: {
                label: "Challenger Build",
                components: [
                  {
                    category: "gpu",
                    product_id: "in-gpu-4060",
                    name: "GeForce RTX 4060",
                    price: 28000,
                    currency: "INR",
                    retailer: "Kryptronix",
                    url: "https://kryptronix.in/rtx4060"
                  }
                ],
                total: 28000,
                subtotal: 28000,
                currency: "INR",
                is_complete: true,
                component_count: 1,
                unpriced_count: 0,
                missing_prices: [],
                currencies: ["INR"],
                parts: {},
                valid: true,
                created_at: new Date().toISOString()
              }
            }
          }
        }
      },
      {
        type: "tool-present_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Challenger Build",
              parts: [
                {
                  category: "gpu",
                  product_id: "in-gpu-4060",
                  name: "RTX 4060",
                  price: 99999, // Model hallucinated/attempted higher price
                  url: "https://hallucinated-scam.com/gpu"
                }
              ]
            }
          ]
        },
        output: { presented: true, buildCount: 1 }
      }
    ];

    const derived = deriveBuilds(parts, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].components[0].price).toBe(28000); // Snapshot price wins
    expect(derived[0].components[0].url).toBe("https://kryptronix.in/rtx4060"); // Snapshot URL wins
  });

  it("never displays a made-up URL for parts without catalog ID", () => {
    const parts: ToolPart[] = [
      {
        type: "tool-validate_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Custom Build",
              parts: { cooler: "Deepcool AG400" }
            }
          ]
        },
        output: {
          builds: {
            "Custom Build": {
              valid: true,
              resolved: {},
              issues: [],
              checks: [],
              snapshot: {
                label: "Custom Build",
                components: [
                  {
                    category: "cooler",
                    product_id: undefined,
                    name: "Deepcool AG400",
                    price: null,
                    currency: "INR"
                  }
                ],
                total: null,
                subtotal: 0,
                currency: "INR",
                is_complete: false,
                component_count: 1,
                unpriced_count: 1,
                missing_prices: ["cooler: Deepcool AG400"],
                currencies: ["INR"],
                parts: {},
                valid: true,
                created_at: new Date().toISOString()
              }
            }
          }
        }
      },
      {
        type: "tool-present_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Custom Build",
              parts: [
                {
                  category: "cooler",
                  name: "Deepcool AG400",
                  price: 1800,
                  url: "https://made-up-store.com/ag400"
                }
              ]
            }
          ]
        },
        output: { presented: true, buildCount: 1 }
      }
    ];

    const derived = deriveBuilds(parts, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].components[0].url).toBeUndefined(); // A made-up URL can't appear
    expect(derived[0].components[0].price).toBeNull();
    expect(derived[0].components[0].notInCatalog).toBe(true);
  });

  it("renders old session fixture unchanged without validation snapshot", () => {
    const oldSessionParts: ToolPart[] = [
      {
        type: "tool-present_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Legacy Session Build",
              parts: [
                {
                  category: "gpu",
                  name: "Legacy RTX 3060",
                  price: 25000,
                  currency: "INR",
                  retailer: "LegacyRetailer",
                  url: "https://legacy.example.com/3060"
                }
              ]
            }
          ]
        },
        output: { presented: true, buildCount: 1 }
      }
    ];

    const derived = deriveBuilds(oldSessionParts, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].components[0].name).toBe("Legacy RTX 3060");
    expect(derived[0].components[0].price).toBe(25000);
    expect(derived[0].components[0].retailer).toBe("LegacyRetailer");
    expect(derived[0].components[0].url).toBe("https://legacy.example.com/3060");
  });

  it("derives build components strictly from snapshot when new-format product_ids is used", () => {
    const parts: ToolPart[] = [
      {
        type: "tool-validate_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Reference Build",
              parts: {
                cpu: { product_id: "in-cpu-5600" },
                cooler: "Deepcool AG400"
              }
            }
          ]
        },
        output: {
          builds: {
            "Reference Build": {
              valid: true,
              resolved: {},
              issues: [],
              checks: [],
              snapshot: {
                label: "Reference Build",
                components: [
                  {
                    category: "cpu",
                    product_id: "in-cpu-5600",
                    name: "AMD Ryzen 5 5600",
                    price: 11490,
                    currency: "INR",
                    retailer: "PrimeABGB",
                    url: "https://primeabgb.com/5600"
                  },
                  {
                    category: "cooler",
                    product_id: undefined,
                    name: "Deepcool AG400",
                    price: null,
                    currency: "INR"
                  }
                ],
                total: null,
                subtotal: 11490,
                currency: "INR",
                is_complete: false,
                component_count: 2,
                unpriced_count: 1,
                missing_prices: ["cooler: Deepcool AG400"],
                currencies: ["INR"],
                parts: {},
                valid: true,
                created_at: new Date().toISOString()
              }
            }
          }
        }
      },
      {
        type: "tool-present_build",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Reference Build",
              product_ids: ["in-cpu-5600"]
            }
          ]
        },
        output: { presented: true, buildCount: 1 }
      }
    ];

    const derived = deriveBuilds(parts, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].components).toHaveLength(2);
    expect(derived[0].components[0].productId).toBe("in-cpu-5600");
    expect(derived[0].components[0].price).toBe(11490);
    expect(derived[0].components[0].retailer).toBe("PrimeABGB");
    expect(derived[0].components[0].url).toBe("https://primeabgb.com/5600");
    expect(derived[0].components[1].notInCatalog).toBe(true);
    expect(derived[0].components[1].price).toBeNull();
    expect(derived[0].components[1].url).toBeUndefined();
  });
});


