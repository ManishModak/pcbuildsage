import { describe, expect, it } from "vitest";
import { createPresentBuildTool, presentBuildInputSchema } from "../tools/present-build";
import {
  deriveBuilds,
  extractBuildsFromMessage,
  parseBuildsFromMarkdown
} from "@/features/chat/build-derive";
import type { ToolPart } from "@/features/chat/tool-chip";

describe("present_build tool", () => {
  it("validates structured input with builds and parts", () => {
    const valid = presentBuildInputSchema.safeParse({
      builds: [
        {
          label: "Max Performance",
          parts: [
            { category: "gpu", name: "RTX 5060", price: 35900, retailer: "Kryptronix", url: "https://kryptronix.in/rtx5060" },
            { category: "cpu", name: "Ryzen 5 5600X", price: 13950 }
          ]
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
          parts: [{ category: "gpu" as const, name: "RTX 5060", price: 35900 }]
        },
        {
          label: "Value Gaming",
          parts: [{ category: "gpu" as const, name: "RTX 5050", price: 24900 }]
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
});

