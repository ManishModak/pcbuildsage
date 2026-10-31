import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { BUILD_CARD_URI } from "../build-card";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config";
import { createPcBuildSageMcpServer } from "../server";

async function connect() {
  const server = await createPcBuildSageMcpServer(resolveConfig({ tier2Enabled: false }));
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

  it("links present_build to the build card, served as an MCP App resource", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "present_build")?._meta).toMatchObject({ ui: { resourceUri: BUILD_CARD_URI } });
    const { contents } = await client.readResource({ uri: BUILD_CARD_URI });
    expect(contents[0]).toMatchObject({ uri: BUILD_CARD_URI, mimeType: RESOURCE_MIME_TYPE });
    expect("text" in contents[0] && contents[0].text).toContain("const __extApps={");
  });
});
