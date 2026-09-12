import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDb } from "@/lib/db";
import { afterEach, describe, it, expect, vi } from "vitest";
import { deriveBuildState, compactChatMessages, type IncomingChatMessage } from "@/lib/llm/messages";
import { consult } from "@/lib/tools/consult";
import type { UIMessage } from "ai";
import type { AppConfig } from "@/types/config";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";

describe("Priority 4: Interruption & Continuation Behavior", () => {
  let temporaryDirectory: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (temporaryDirectory) {
      closeDb(path.join(temporaryDirectory, "products.db"));
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });
  describe("State Derivation & Recovery across Turns", () => {
    it("successfully derives build state and verdict from prior validate_build tool invocation", () => {
      const mockMessages: UIMessage[] = [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "Can you validate my build with Ryzen 5 7600 and RTX 4070?" }]
        },
        {
          id: "m2",
          role: "assistant",
          parts: [
            {
              type: "tool-validate_build",
              input: {
                parts: [
                  { category: "cpu", name: "AMD Ryzen 5 7600" },
                  { category: "gpu", name: "Nvidia RTX 4070" }
                ]
              },
              output: {
                valid: true,
                issues: []
              }
            } as unknown as UIMessage["parts"][number]
          ]
        }
      ];

      const derived = deriveBuildState(mockMessages);
      expect(derived).not.toBeNull();
      expect(derived?.parts).toEqual([
        { category: "cpu", name: "AMD Ryzen 5 7600" },
        { category: "gpu", name: "Nvidia RTX 4070" }
      ]);
      expect(derived?.verdict).toEqual({
        valid: true,
        blocking: 0,
        issues: 0
      });
    });

    it("returns null when no validate_build calls exist", () => {
      const mockMessages: UIMessage[] = [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ];

      expect(deriveBuildState(mockMessages)).toBeNull();
    });

    it("compacts historical messages while preserving immediate tool context and text continuity", () => {
      const incoming: IncomingChatMessage[] = [
        {
          role: "user",
          content: "Search for 750W PSU"
        },
        {
          role: "assistant",
          content: "I found a few PSUs.",
          parts: [
            {
              type: "tool-search_products",
              output: {
                products: [
                  { id: "1", name: "Cooler Master 750W", price: 6000, category: "psu" }
                ]
              }
            }
          ]
        },
        {
          role: "user",
          content: "Now check DDR5 RAM"
        },
        {
          role: "assistant",
          content: "Here is the DDR5 RAM.",
          parts: [
            {
              type: "tool-search_products",
              output: {
                products: [
                  { id: "2", name: "Corsair Vengeance 32GB DDR5", price: 9000, category: "ram" }
                ]
              }
            }
          ]
        }
      ];

      const compacted = compactChatMessages(incoming);
      expect(compacted.length).toBe(4);
      // Turn 1 assistant stripped of bloated tool parts, converted to lean text part
      expect(compacted[1].parts).toEqual([
        { type: "text", text: "I found a few PSUs." }
      ]);
      // Latest assistant retains tool context for immediate continuation
      expect(compacted[3].parts?.[0]?.type).toBe("tool-search_products");
    });
  });

  describe("Subagent Interruption and Abort Handling", () => {
    it("handles the subagent timeout without retrying or caching partial results", async () => {
      temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pcbuildsage-interruption-"));
      const timeoutController = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
      const baseConfig: AppConfig = {
        ...DEFAULT_CONFIG,
        dbPath: path.join(temporaryDirectory, "products.db"),
        llm: {
          chain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }],
          roles: {
            chat: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }],
            subagent: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }],
            scraper: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }]
          }
        },
        search: { provider: "tavily", apiKey: "tvly-key", crawlEnabled: false }
      };

      const generateText = vi.fn().mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
          timeoutController.abort(new DOMException("The operation timed out", "TimeoutError"));
        })
      );

      const result = (await consult(
        {
          mode: "component_specs",
          name: "G.Skill Flare X5 32GB",
          category: "ram"
        },
        baseConfig,
        {
          generateText,
          searchClient: { search: vi.fn().mockResolvedValue({ results: [], provider: "none", grounded: false }) },
          logPath: path.join(temporaryDirectory, "consult.jsonl")
        }
      )) as { label?: string; retryable?: boolean; actions?: unknown[] };

      expect(result.label).toBe("unverified");
      expect(result.retryable).toBe(false);
      expect(result.actions).toEqual([]);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(timeoutController.signal.aborted).toBe(true);
      expect(getDb(baseConfig.dbPath).prepare("SELECT COUNT(*) AS count FROM registry_research").get()).toEqual({ count: 0 });
    });
  });
});
