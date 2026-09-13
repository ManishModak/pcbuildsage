import { describe, expect, it, vi } from "vitest";
import { createValidateBuildTool } from "../tools/validate-build";
import { deriveBuildsFromToolParts } from "@/features/chat/build-derive";
import { toCompactProductItem, type CatalogRepository } from "../catalog";
import type { ToolPart } from "@/features/chat/tool-chip";

const scope = { countryCode: "IN", currency: "INR" };
const gpu = { id: "offer-gpu", name: "Sapphire PURE RX 7700 XT 12GB WHITE", category: "gpu", registry_key: "amd-rx-7700-xt" };
const cpu = { id: "offer-cpu", name: "AMD Ryzen 5 5500 Processor", category: "cpu", registry_key: "amd-ryzen-5-5500" };
const pcCase = { id: "offer-case", name: "Deepcool CC560 Limited V2", category: "case", registry_key: "deepcool-cc560-v2" };

function repository() {
  return { searchProducts: vi.fn(async () => ({ results: [gpu, pcCase, cpu] })) } as unknown as CatalogRepository;
}

async function validate(parts: Record<string, { product_id: string; key?: string }>, repo = repository()) {
  const tool = createValidateBuildTool(scope, repo);
  return await tool.execute!({ parts }, { toolCallId: "validation", messages: [], context: {} });
}

describe("catalog product identity through validation and presentation", () => {
  it("looks up authoritative products and retains only the GPU/case warning", async () => {
    const repo = repository();
    const parts = { gpu: { product_id: gpu.id, key: "nvidia-rtx-4090" }, case: { product_id: pcCase.id }, cpu: { product_id: cpu.id } };
    const output = await validate(parts, repo);
    expect(repo.searchProducts).toHaveBeenCalledWith({ product_ids: [gpu.id, pcCase.id, cpu.id], in_stock: false, limit: 3 }, scope);
    expect(output).toMatchObject({ resolved: { gpu: { key: gpu.id, spec: { vram_gb: 12 } } } });
    const calls = [
      { type: "tool-validate_build", state: "output-available", input: { parts }, output },
      { type: "tool-present_build", state: "input-available", input: { builds: [{ parts: [
        { category: "gpu", product_id: gpu.id, name: gpu.name },
        { category: "case", product_id: pcCase.id, name: pcCase.name },
        { category: "cpu", product_id: cpu.id, name: cpu.name }
      ] }] } }
    ] as ToolPart[];
    const [build] = deriveBuildsFromToolParts(calls, "INR");
    expect(build.validation).toBe(output);
    expect(build.components.filter((part) => part.category !== "cpu").every((part) => part.unverifiedNote?.includes("GPU fit"))).toBe(true);
    expect(build.components.find((part) => part.category === "cpu")?.unverified).toBe(false);
    const presentation = calls[1].input as { builds: Array<{ parts: Array<{ product_id: string }> }> };
    presentation.builds[0].parts[0].product_id = "different-offer-same-model";
    expect(deriveBuildsFromToolParts(calls, "INR")[0].validation).toBeNull();
  });

  it("does not fall back to a supplied registry key for unknown IDs or wrong categories", async () => {
    const result = await validate({ cpu: { product_id: gpu.id, key: "amd-ryzen-5-5500" }, gpu: { product_id: "missing", key: "amd-rx-7700-xt" } });
    expect(result).toMatchObject({ resolved: {}, summary: { unverified: 2 } });
  });

  it("adds modules to existing catalog records without rewriting stored specs", () => {
    const record = { name: "Patriot 32GB (32GB×1) DDR5", category: "ram", specs: { capacity_gb: 32, ddr: "DDR5" } };
    expect(toCompactProductItem(record).specs).toMatchObject({ modules: 1, capacity_gb: 32 });
    expect(record.specs).not.toHaveProperty("modules");
  });
});
