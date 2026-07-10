import { stepCountIs, type ModelMessage } from "ai";
import type { AppConfig } from "./config-types";
import { streamTextWithFallback } from "./llm-client";
import { appendChatLog } from "./logger";
import { createToolRegistry } from "./tools";
import { getPersona } from "./personas";
import { getPersonality } from "./personalities";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export function buildSystemPrompt(config: AppConfig): string {
  const personaIds = config.personas?.length ? config.personas : [config.persona];
  const personas = personaIds
    .map((id) => getPersona(id))
    .filter((persona): persona is NonNullable<typeof persona> => Boolean(persona));
  const personality = getPersonality(config.personality);
  const personaLine = (persona: (typeof personas)[number], prefix: string) =>
    `${prefix}${persona.persona_name}. Budget weights: ${JSON.stringify(persona.budget_weights)}. Priorities: ${persona.priorities.join(", ")}. Tone: ${persona.tone}.`;
  const personaLines =
    personas.length > 1
      ? [
          `Compare these build personas, proposing one complete build for each: ${personas.map((persona) => persona.persona_name).join(", ")}.`,
          ...personas.map((persona) => personaLine(persona, "Persona "))
        ]
      : personas.map((persona) => personaLine(persona, "Persona: "));
  return [
    "You are PCBuildSage, a PC build consultant powered by local product data and deterministic compatibility checks.",
    "Component cascade: GPU -> CPU -> Motherboard -> RAM -> Storage -> PSU -> Case -> Cooler. You may deviate when the user provides owned parts or hard constraints.",
    `Active scope: country ${config.countryCode}, currency ${config.currency}. All prices from tools are integer minor units and must not be mixed across currencies.`,
    ...personaLines,
    personality ? `Personality prompt: ${personality.prompt}` : "",
    "Tool protocol: use search_products for purchasable candidates; filters include category, price range, brands, retailer, in_stock, socket, ddr, form_factor, min_vram_gb, max_tdp_w, max_length_mm, sort_by, order, limit.",
    "Call validate_build before locking each component choice and always on the final build.",
    "When validate_build returns needs_research, call consult in component_specs mode for that part, then rerun validate_build. Never guess specs.",
    "Disclose researched specs as not community-verified. Tier 2 build_audit is advisory-only and can never clear a Tier 1 blocking failure.",
    config.tier2Enabled ? "On the final assembled build, call consult in build_audit mode once." : "Tier 2 consult is disabled; do not ask for advisory research."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function streamChat(config: AppConfig, messages: ChatMessage[]) {
  const lastUser = messages.filter((message) => message.role === "user").at(-1);
  if (lastUser) {
    appendChatLog({ role: "user", content: lastUser.content });
  }
  return streamTextWithFallback({
    chain: config.llm.roles.chat,
    system: buildSystemPrompt(config),
    messages: messages as ModelMessage[],
    tools: createToolRegistry(config),
    stopWhen: stepCountIs(12),
    onStepFinish: (step) => {
      const resultsById = new Map(step.toolResults.map((result) => [result.toolCallId, result]));
      for (const call of step.toolCalls) {
        const result = resultsById.get(call.toolCallId);
        appendChatLog({
          role: "tool",
          toolName: String(call.toolName),
          toolArgs: call.input,
          toolResult: result ? summarizeToolResult(result) : undefined,
          provider: step.model.provider,
          modelId: step.model.modelId
        });
      }
    },
    onFinish: (finish) => {
      appendChatLog({
        role: "assistant",
        content: finish.text,
        provider: finish.model.provider,
        modelId: finish.model.modelId
      });
    }
  });
}

function summarizeToolResult(result: unknown) {
  if (typeof result !== "object" || result === null) return result;
  const value = result as Record<string, unknown>;
  return {
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    output: value.output,
    error: value.error instanceof Error ? value.error.message : value.error
  };
}
