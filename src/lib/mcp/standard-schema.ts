/**
 * src/lib/mcp/standard-schema.ts
 *
 * Wraps an AI SDK schema as a Standard Schema with JSON (`~standard`), the
 * only shape MCP SDK v2's McpServer.registerTool accepts. The advertised JSON
 * Schema and the validation both come from the AI SDK schema, so lenient
 * coercion (lenient-input.ts) keeps working exactly as in the web chat.
 *
 * The SDK reads the JSON Schema synchronously, so it must be resolved first:
 * use toStandardSchema(await resolveAiSchema(tool.inputSchema)).
 */
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { asSchema, type FlexibleSchema, type JSONSchema7, type Schema } from "ai";

export interface ResolvedAiSchema {
  schema: Schema<unknown>;
  jsonSchema: JSONSchema7;
}

/** Normalises any AI SDK input schema and awaits its (possibly lazy) JSON Schema. */
export async function resolveAiSchema(input: FlexibleSchema<unknown>): Promise<ResolvedAiSchema> {
  const schema = asSchema(input);
  return { schema, jsonSchema: await schema.jsonSchema };
}

export function toStandardSchema({ schema, jsonSchema }: ResolvedAiSchema): StandardSchemaWithJSON {
  return {
    "~standard": {
      version: 1,
      vendor: "pcbuildsage-ai-sdk",
      validate: async (value) => {
        if (!schema.validate) return { value };
        const result = await schema.validate(value);
        return result.success ? { value: result.value } : { issues: [{ message: result.error.message }] };
      },
      jsonSchema: {
        input: () => jsonSchema as Record<string, unknown>,
        output: () => jsonSchema as Record<string, unknown>
      }
    }
  };
}
