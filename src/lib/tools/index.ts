import type { ToolSet } from "ai";
import type { AppConfig } from "../config-types";
import { createSearchProductsTool } from "./search-products";
import { createValidateBuildTool } from "./validate-build";
import { createConsultTool } from "./consult";

export function createToolRegistry(config: AppConfig): ToolSet {
  const tools: ToolSet = {
    search_products: createSearchProductsTool({ dbPath: config.dbPath, countryCode: config.countryCode, currency: config.currency }),
    validate_build: createValidateBuildTool()
  };
  if (config.tier2Enabled) {
    tools.consult = createConsultTool(config);
  }
  return tools;
}

export { createSearchProductsTool, searchProducts } from "./search-products";
export { createValidateBuildTool } from "./validate-build";
export { createConsultTool, consult } from "./consult";
