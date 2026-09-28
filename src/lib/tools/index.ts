import type { ToolSet } from "ai";
import type { AppConfig } from "@/types";
import type { CatalogRepository } from "@/lib/catalog";
import { createSearchProductsTool } from "./search-products";
import { createListModelsTool } from "./list-models";
import { createValidateBuildTool } from "./validate-build";
import { createPresentBuildTool } from "./present-build";
import { createSuggestFollowupsTool } from "./suggest-followups";
import { createConsultTool } from "./consult";
import { createTurnValidationStore } from "./turn-state";

export function createToolRegistry(config: AppConfig, options?: { repository?: CatalogRepository }): ToolSet {
  const turnStore = createTurnValidationStore();
  const tools: ToolSet = {
    search_products: createSearchProductsTool(
      { dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency, repository: options?.repository },
      options?.repository
    ),
    list_models: createListModelsTool(
      { dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency, repository: options?.repository },
      options?.repository
    ),
    validate_build: createValidateBuildTool(
      { dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency }, options?.repository, turnStore
    ),
    present_build: createPresentBuildTool(turnStore),
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
export { createPresentBuildTool } from "./present-build";
export { createConsultTool, consult } from "./consult";
export { createTurnValidationStore, recordValidation, validLabels, normalizeLabel } from "./turn-state";
export type { TurnValidationStore, TurnValidationEntry } from "./turn-state";
export { resolveIdPrefix, idsMatch, shortId, SHORT_ID_LEN, MIN_PREFIX_LEN } from "./product-ids";
