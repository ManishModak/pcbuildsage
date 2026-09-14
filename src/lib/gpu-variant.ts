/** Variant information explicitly stated in a GPU listing or registry model name. */
export function gpuVariant(name: string): { family?: string; vram?: number } {
  const family = name.match(/\b(?:(?:RTX|GTX|RX)\s*\d{3,4}(?:\s*(?:XTX|XT|Ti|Super)){0,2}|Arc\s*[AB]\d{3})\b/i);
  const capacities = [...name.matchAll(/\b(\d+)\s*GB\b/gi)].map((match) => Number(match[1]));
  const unique = [...new Set(capacities)];
  return {
    family: family?.[0].replace(/\s+/g, "").toLowerCase(),
    vram: unique.length === 1 && unique[0] > 0 ? unique[0] : undefined
  };
}
