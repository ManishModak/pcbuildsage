/**
 * Track B: streamChat injection point (tools + systemPromptSuffix) and
 * CallToolResult-aware step analysis for MCP-backed tools.
 *
 * Default-path assertions live in the existing chat-engine tests, which must
 * pass unmodified; these cover only the alexa overrides and the MCP output
 * shape (which chat tools never emit).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dynamicTool, jsonSchema } from "ai";
import {
  hasPresentedBuild,
  hasSuccessfulValidation,
  streamChat
} from "../chat-engine";
import * as clientModule from "../client";
import type { AppConfig } from "@/types";

vi.mock("../client", () => ({
  streamTextWithFallback: vi.fn(),
  generateTextWithFallback: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  appendChatLog: vi.fn().mockResolvedValue(undefined)
}));

const config: AppConfig = {
  dbPath: ":memory:",
  countryCode: "US",
  currency: "USD",
  personality: "balanced",
  theme: "sage-dark",
  tier2Enabled: false,
  freeformConsultEnabled: false,
  llm: {
    chain: [],
    roles: {
      chat: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none", contextLimit: 65_536 }],
      subagent: [],
      scraper: []
    }
  },
  search: { provider: "none", crawlEnabled: false }
};

const SUFFIX = "Voice mode: test suffix.";

function mcpResult(structured: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured
  };
}

describe("streamChat alexa overrides", () => {
  let captured: { system?: string; tools?: Record<string, unknown> } | undefined;

  beforeEach(() => {
    captured = undefined;
    vi.mocked(clientModule.streamTextWithFallback).mockImplementation((options: unknown) => {
      const opts = options as { system?: string; tools?: Record<string, unknown> };
      captured = { system: opts.system, tools: opts.tools };
      return { provider: "p", model: "m" } as never;
    });
  });

  it("uses the local registry and no suffix by default", async () => {
    await streamChat(config, [{ role: "user", content: "hi" }]);
    expect(Object.keys(captured!.tools!)).toEqual(
      expect.arrayContaining(["search_products", "validate_build", "present_build"])
    );
    expect(captured!.system).toContain("PCBuildSage");
    expect(captured!.system).not.toContain(SUFFIX);
  });

  it("swaps in MCP tools and wraps the prompt with the voice rules when given", async () => {
    const mcpTools = {
      only_mcp_tool: dynamicTool({
        description: "from mcp",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({})
      })
    };
    await streamChat(config, [{ role: "user", content: "hi" }], "session-1", undefined, null, undefined, {
      tools: mcpTools,
      systemPromptPrefix: "VOICE RULES",
      systemPromptSuffix: SUFFIX
    });
    expect(Object.keys(captured!.tools!)).toEqual(["only_mcp_tool"]);
    expect(captured!.system!.startsWith("VOICE RULES")).toBe(true);
    expect(captured!.system).toContain("PCBuildSage");
    expect(captured!.system!.endsWith(SUFFIX)).toBe(true);
  });
});

describe("step analysis with MCP CallToolResult outputs", () => {
  const wholeBuild = [{ category: "cpu" }, { category: "motherboard" }];

  it("sees validation success inside structuredContent", () => {
    const steps = [
      {
        toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }],
        toolResults: [
          {
            toolCallId: "v1",
            toolName: "validate_build",
            output: mcpResult({ builds: { "Within budget": { valid: true, issues: [], snapshot: { components: wholeBuild } } } })
          }
        ]
      }
    ];
    expect(hasSuccessfulValidation(steps)).toBe(true);
  });

  it("sees a presented build inside structuredContent, and rejects presented:false", () => {
    const presented = [
      {
        toolCalls: [{ toolName: "present_build", toolCallId: "p1" }],
        toolResults: [
          { toolCallId: "p1", toolName: "present_build", output: mcpResult({ presented: true, builds: [], cards: [] }) }
        ]
      }
    ];
    expect(hasPresentedBuild(presented)).toBe(true);

    const refused = [
      {
        toolCalls: [{ toolName: "present_build", toolCallId: "p1" }],
        toolResults: [
          {
            toolCallId: "p1",
            toolName: "present_build",
            output: mcpResult({ presented: false, error: "nope", valid_labels: [] })
          }
        ]
      }
    ];
    expect(hasPresentedBuild(refused)).toBe(false);
  });

  it("still reads plain chat-shaped outputs (default path unchanged)", () => {
    const steps = [
      {
        toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }],
        toolResults: [
          {
            toolCallId: "v1",
            toolName: "validate_build",
            output: { builds: { "Within budget": { valid: true, issues: [], snapshot: { components: wholeBuild } } } }
          }
        ]
      }
    ];
    expect(hasSuccessfulValidation(steps)).toBe(true);
    expect(
      hasSuccessfulValidation([
        {
          toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }],
          toolResults: [{ toolCallId: "v1", toolName: "validate_build", output: { builds: {} } }]
        }
      ])
    ).toBe(false);
  });
});
