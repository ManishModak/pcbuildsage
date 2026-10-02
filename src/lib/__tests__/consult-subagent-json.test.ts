import { describe, expect, it } from "vitest";
import { parseJsonObject } from "@/lib/tools/consult";

describe("parseJsonObject subagent parser", () => {
  it("parses clean JSON payload", () => {
    const input = '{"specs": {"brand": "AMD", "model": "Ryzen 7 9700X"}, "sources": ["https://amd.com"]}';
    const parsed = parseJsonObject(input) as any;
    expect(parsed.specs.brand).toBe("AMD");
    expect(parsed.sources).toEqual(["https://amd.com"]);
  });

  it("strips <think> tags containing braces that would break greedy regex", () => {
    const input = `<think>
I need to check the specs for { "model": "ASUS Dual RTX 4060 Ti" }.
Wait, let's verify dimensions: { "length_mm": 227 } and TDP.
</think>
{"specs": {"brand": "ASUS", "model": "Dual GeForce RTX 4060 Ti OC Edition 8GB", "length_mm": 227}, "sources": ["https://asus.com"]}`;
    const parsed = parseJsonObject(input) as any;
    expect(parsed.specs.brand).toBe("ASUS");
    expect(parsed.specs.length_mm).toBe(227);
  });

  it("extracts JSON from markdown code fence", () => {
    const input = `Here is the requested specification:
\`\`\`json
{
  "specs": {
    "brand": "Ant Esports",
    "model": "211TG",
    "form_factor": "Mid Tower"
  },
  "sources": ["https://antesports.com"]
}
\`\`\`
Hope this helps!`;
    const parsed = parseJsonObject(input) as any;
    expect(parsed.specs.brand).toBe("Ant Esports");
    expect(parsed.specs.form_factor).toBe("Mid Tower");
  });

  it("handles reasoning <think> tags combined with markdown code fence", () => {
    const input = `<think>
Analyzing motherboard: { "socket": "AM5" }
</think>
\`\`\`json
{
  "specs": {
    "brand": "Gigabyte",
    "model": "B650E AORUS ELITE X AX ICE",
    "socket": "AM5"
  },
  "sources": ["https://gigabyte.com"]
}
\`\`\``;
    const parsed = parseJsonObject(input) as any;
    expect(parsed.specs.brand).toBe("Gigabyte");
    expect(parsed.specs.socket).toBe("AM5");
  });

  it("throws when no JSON object exists", () => {
    expect(() => parseJsonObject("Just plain text with no braces.")).toThrow(
      "No JSON object found in model response."
    );
  });
});
