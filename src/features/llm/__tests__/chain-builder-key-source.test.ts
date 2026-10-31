import { describe, expect, it } from "vitest";
import { newEntry, withAvailableKeySources } from "../chain-builder";
import type { CredentialAvailability } from "@/types/client";

describe("withAvailableKeySources", () => {
  const credentials: CredentialAvailability = { llm: { gemini: true }, search: {} };

  it("moves an entry off the server's key when the server has none for it", () => {
    const chain = [
      newEntry({ provider: "groq" }),
      newEntry({ provider: "ollama" }),
      newEntry({ provider: "groq", keySource: "ui" })
    ];
    expect(withAvailableKeySources(chain, credentials).map((entry) => entry.keySource)).toEqual(["ui", "none", "ui"]);
  });

  it("keeps the server's key when it exists, returning the same array", () => {
    const chain = [newEntry({ provider: "gemini" })];
    expect(withAvailableKeySources(chain, credentials)).toBe(chain);
  });
});
