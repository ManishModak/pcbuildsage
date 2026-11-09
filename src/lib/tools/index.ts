import type { ToolSet } from "ai";
import type { AppConfig } from "@/types";
import type { CatalogRepository } from "@/lib/catalog";
import { createSearchProductsTool } from "./search-products";
import { createListModelsTool } from "./list-models";
import { createValidateBuildTool } from "./validate-build";
import { createPresentBuildTool } from "./present-build";
import { createSuggestFollowupsTool } from "./suggest-followups";
import { createConsultTool } from "./consult";
import { createTurnValidationStore, type TurnValidationStore } from "./turn-state";

/**
 * Builds the tool set for one chat turn or MCP session. Pass `turnStore` to
 * read the validate_build snapshots afterwards (the MCP build card does).
 * `requireCatalogParts` (web chat) keeps builds a user couldn't buy as shown
 * from being presented; see createValidateBuildTool.
 */
export function createToolRegistry(
  config: AppConfig,
  options?: { repository?: CatalogRepository; turnStore?: TurnValidationStore; requireCatalogParts?: boolean; userText?: string }
): ToolSet {
  const turnStore = options?.turnStore ?? createTurnValidationStore();
  const validateBuild = createValidateBuildTool(
    { dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency }, options?.repository, turnStore,
    { requireCatalogParts: options?.requireCatalogParts, userText: options?.userText }
  );
  const search = createSearchProductsTool(
    { dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency, repository: options?.repository },
    options?.repository
  );
  // Full ID to category of every row a search returned this turn, so present_build can validate a build of searched parts.
  const found = new Map<string, string>();
  const tools: ToolSet = {
    search_products: {
      ...search,
      execute: async (input, ctx) => {
        const output = await search.execute!(input, ctx);
        for (const row of (output as { results?: Array<{ id?: unknown; category?: unknown }> }).results ?? []) {
          if (typeof row?.id === "string" && typeof row.category === "string") found.set(row.id, row.category);
        }
        return output;
      }
    },
    list_models: createListModelsTool(
      { dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency, repository: options?.repository },
      options?.repository
    ),
    validate_build: validateBuild,
    present_build: createPresentBuildTool(turnStore, {
      found,
      revalidate: (label, parts, budget) =>
        Promise.resolve(validateBuild.execute!({ builds: [{ label, parts }], ...(budget !== undefined ? { budget } : {}) } as never, { toolCallId: "present-revalidate", messages: [] } as never))
    }),
    suggest_followups: createSuggestFollowupsTool()
  };

  if (config.tier2Enabled && config.search.provider !== "none") {
    tools.consult = createConsultTool(config);
  }
  return tools;
}

export { createSearchProductsTool, searchProducts } from "./search-products";
export { createGetCatalogTool, getCatalog } from "./get-catalog";
export { createListModelsTool, listModels } from "./list-models";
export { createValidateBuildTool, toModelValidateOutput } from "./validate-build";
export { createPresentBuildTool, toModelPresentOutput } from "./present-build";
export { createConsultTool, consult } from "./consult";
export { createTurnValidationStore, recordValidation, validLabels, normalizeLabel } from "./turn-state";
export type { TurnValidationStore, TurnValidationEntry } from "./turn-state";
export { resolveIdPrefix, idsMatch, shortId, SHORT_ID_LEN, MIN_PREFIX_LEN } from "./product-ids";
