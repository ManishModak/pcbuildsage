import { describe, expect, it } from "vitest";
import { BUILD_CARD_URI } from "@/lib/mcp/build-card";
import { BUILD_CARD_URI_FALLBACK } from "../card-uri";

describe("card-uri fallback", () => {
  it("matches the server's BUILD_CARD_URI", () => {
    expect(BUILD_CARD_URI_FALLBACK).toBe(BUILD_CARD_URI);
  });
});
