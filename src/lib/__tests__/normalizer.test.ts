import { describe, expect, it } from "vitest";
import { normalizeTitle } from "../normalizer";

describe("normalizeTitle", () => {
  it("canonicalizes G.Skill punctuation variants", () => {
    expect(normalizeTitle("G.Skill Trident Z5")).toBe(normalizeTitle("G-Skill Trident Z5"));
    expect(normalizeTitle("GSkill Trident Z5")).toBe(normalizeTitle("G Skill Trident Z5"));
  });
});
