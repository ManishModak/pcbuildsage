import { describe, expect, it } from "vitest";
import { identifyingTokens, unnamedOwnedParts, userNamesPart } from "../owned-parts";

describe("owned parts the user never named", () => {
  it("identifies parts by model numbers, else distinctive words", () => {
    expect(identifyingTokens("MSI GeForce RTX 3070 Ventus 2X")).toEqual(["3070"]);
    expect(identifyingTokens("AMD Wraith Stealth")).toEqual(["wraith", "stealth"]);
    expect(identifyingTokens("my old GPU")).toEqual([]);
    expect(userNamesPart("RTX 3070", "I already have an RTX 3070 from my old PC.")).toBe(true);
    expect(userNamesPart("my old graphics card", "Build around my old graphics card")).toBe(true);
  });

  it("lists owned parts the user's words don't name, and leaves named or bought ones alone", () => {
    const components = [
      { category: "gpu", name: "RTX 3070", owned: true },
      { category: "cpu", name: "AMD Ryzen 5 5600" },
      { category: "storage", name: "Samsung 980 1TB", owned: true }
    ];
    expect(unnamedOwnedParts(components, "₹50,000 mein gaming PC chahiye")).toEqual(['gpu "RTX 3070"', 'storage "Samsung 980 1TB"']);
    expect(unnamedOwnedParts(components, "I already have an RTX 3070 and a Samsung 980")).toEqual([]);
  });
});
