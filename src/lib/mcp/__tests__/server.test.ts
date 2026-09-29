import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config";
import { createPcBuildSageMcpServer } from "../server";

async function connect() {
  const server = createPcBuildSageMcpServer(resolveConfig({ tier2Enabled: false }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("PCBuildSage MCP server", () => {
  it("exposes the chat tools with JSON schemas, minus chat-UI-only tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["list_models", "present_build", "search_products", "validate_build"]);
    const search = tools.find((tool) => tool.name === "search_products");
    expect(search?.inputSchema.properties).toHaveProperty("category");
  });

  it("returns schema errors as tool errors instead of throwing", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "present_build", arguments: { builds: "not-an-array" } });
    expect(result.isError).toBe(true);
  });

  it("keeps validations per session: present_build refuses labels this session never validated", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "present_build", arguments: { builds: [{ label: "budget" }] } });
    expect(result.structuredContent).toMatchObject({ presented: false, valid_labels: [] });
  });
});
