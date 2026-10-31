/**
 * Test harness for driving the real chat pipeline with the AI SDK's mocked model.
 *
 * The point of this file is fidelity: `streamChat`, the real tool registry and the
 * real `validate_build` tool all run, so a `validate_build` call produces a real
 * `BuildSnapshot` (real names, real prices, real `total: null` when incomplete)
 * instead of a hand-written fixture that can drift from the product's shape.
 *
 * Only three things are substituted:
 *   - `createLanguageModel` -> a scripted `MockLanguageModelV4`
 *   - `getCatalogRepository` -> a small in-memory catalog
 *   - the model call is aborted part-way through, to produce the interrupted state
 *     that a real session gets saved in when a user closes the tab mid-stream.
 */
import { MockLanguageModelV4 } from "ai/test";
import { readUIMessageStream, type UIMessage } from "ai";
import type { AppConfig } from "@/types";
import type { CatalogRepository, SearchProductItem } from "@/lib/catalog";

/** A step the scripted model should emit on one model call. */
export type ScriptedStep =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; toolCallId: string; toolName: string; input: unknown }
  /**
   * Emit the preceding steps, then leave the stream open forever. The test aborts it,
   * which is how a tab closed mid-turn leaves a tool call with no output — the state
   * a real interrupted session is saved in.
   */
  | { kind: "hang" };

/**
 * The catalog the fake `validate_build` resolves against. Deliberately mirrors the
 * shape of a real IN snapshot: a 32-hex product id, a registry key, a rupee price,
 * a retailer and a link, plus one part deliberately left unpriced so the snapshot's
 * `total` comes back `null` (an incomplete build must never render as a real total).
 */
export const FIXTURE_PARTS = {
  gpu: {
    id: "1ee22f4e68844a8440d5ef8793f8319fb21ba7b",
    registry_key: "nvidia-geforce-rtx-4060",
    name: "NVIDIA GeForce RTX 4060 8GB",
    price: 31500,
    category: "gpu"
  },
  cpu: {
    id: "654105021be32bb123e9d04c1563f2392880fce2",
    registry_key: "amd-ryzen-5-5600",
    name: "AMD Ryzen 5 5600",
    price: 13490,
    category: "cpu"
  },
  motherboard: {
    id: "d1d2044f9a831b22b749eeb825e4a54766f76ec1",
    registry_key: "msi-b550m-pro-d",
    name: "MSI B550M PRO-VDH WIFI",
    price: 9450,
    category: "motherboard"
  },
  ram: {
    id: "2f0e1c9b7d4a6e8f0a2b4c6d8e0f2a4b",
    registry_key: "corsair-vengeance-rgb-pro-16gb",
    name: "Corsair Vengeance RGB Pro 16GB (8GB x2) DDR4 3200MHz",
    price: 2899,
    category: "ram"
  },
  storage: {
    id: "3a1b2c3d4e5f60718293a4b5c6d7e8f9",
    registry_key: "samsung-980-500gb",
    name: "Samsung 980 500GB NVMe SSD",
    price: 4199,
    category: "storage"
  },
  psu: {
    id: "4b2c3d4e5f60718293a4b5c6d7e8f901",
    registry_key: "corsair-cv550",
    name: "Corsair CV550 550W 80+ Bronze",
    price: 3499,
    category: "psu"
  },
  /** Deliberately unpriced: the catalog has no listing, so `snapshot.total` must be null. */
  case: {
    id: "5c3d4e5f60718293a4b5c6d7e8f90112",
    registry_key: "",
    name: "Antec NX292 Gaming Case",
    price: null,
    category: "case"
  }
} as const;

export type FixtureCategory = keyof typeof FIXTURE_PARTS;

const ALL_PARTS: SearchProductItem[] = (
  Object.keys(FIXTURE_PARTS) as FixtureCategory[]
).map((category) => {
  const part = FIXTURE_PARTS[category];
  return {
    id: part.id,
    name: part.name,
    registry_key: part.registry_key || undefined,
    price: part.price,
    currency: "INR",
    country_code: "IN",
    category: part.category,
    retailer: "MDComputers",
    url: `https://mdcomputers.in/product/${part.id}`,
    in_stock: true,
    first_seen: "2026-08-01T00:00:00Z",
    last_scraped: "2026-08-16T08:32:01Z"
  } as SearchProductItem;
});

/**
 * The exact `input` a model sends to `validate_build`. The tool validates a *batch* of
 * builds (`{ builds: [{ label, parts }] }`), so this mirrors that rather than the older
 * single-build shape.
 */
export function fixtureValidateInput(categories: FixtureCategory[], label = "Max frames now") {
  const parts: Record<string, { product_id: string }> = {};
  for (const category of categories) {
    parts[FIXTURE_PARTS[category].category] = { product_id: FIXTURE_PARTS[category].id };
  }
  return { builds: [{ label, parts }] };
}

/** The exact `input` a model sends to `present_build` (product ids, no prices). */
export function fixturePresentInput(categories: FixtureCategory[], label = "Max frames now") {
  return {
    builds: [
      {
        label,
        product_ids: categories.map((category) => FIXTURE_PARTS[category].id)
      }
    ]
  };
}

/** A minimal `CatalogRepository`: only `searchProducts` is reachable from validate_build. */
export function createFakeCatalog(): CatalogRepository {
  return {
    async searchProducts(input: { product_ids?: string[] }) {
      const ids = input.product_ids ?? [];
      const results = ALL_PARTS.filter((product) => ids.includes(product.id));
      return { results, total_matching: results.length } as never;
    },
    async getCatalog() {
      return { categories: [] } as never;
    },
    async listModels() {
      return { models: [] } as never;
    },
    async getCategoryBaseline() {
      return { total: 0, in_stock: 0 } as never;
    },
    async getFreshness() {
      return { last_scraped: null, total_products: ALL_PARTS.length } as never;
    }
  } as unknown as CatalogRepository;
}

/**
 * A model that replays one script per call, so a multi-step tool-calling turn is
 * driven step by step: call 1 validates, call 2 presents.
 *
 * Pass the caller's `AbortSignal` when any script hangs. The hung stream then closes
 * itself on abort, so the consumer's loop ends *naturally*. That matters: breaking out
 * of a `for await` cancels the reader, which closes the UI output stream's controller,
 * and the AI SDK's own `toUIMessageStream` teardown then closes it a second time — an
 * unhandled rejection that fails CI while every test still passes.
 */
export function createScriptedModel(
  scripts: ScriptedStep[][],
  options: { signal?: AbortSignal } = {}
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const steps = scripts[Math.min(call, scripts.length - 1)] ?? [];
      call += 1;
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      let seq = 0;
      let hangs = false;
      for (const step of steps) {
        if (step.kind === "hang") {
          hangs = true;
          continue;
        }
        if (step.kind === "text") {
          // The id must be stable across start/delta/end: the SDK joins on it.
          const id = `text-${seq++}`;
          parts.push({ type: "text-start", id });
          parts.push({ type: "text-delta", id, delta: step.text });
          parts.push({ type: "text-end", id });
        } else if (step.kind === "reasoning") {
          const id = `reasoning-${seq++}`;
          parts.push({ type: "reasoning-start", id });
          parts.push({ type: "reasoning-delta", id, delta: step.text });
          parts.push({ type: "reasoning-end", id });
        } else {
          // A complete `tool-call` part: the SDK then executes the real tool
          // against the real registry, so validate_build produces a real snapshot.
          parts.push({
            type: "tool-call",
            toolCallId: step.toolCallId,
            toolName: step.toolName,
            input: JSON.stringify(step.input)
          });
        }
      }
      if (hangs) {
        // Stay open until the caller aborts, then close cleanly so the consumer's
        // loop can finish without being cancelled.
        const { signal } = options;
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              if (signal?.aborted) {
                controller.close();
                return;
              }
              signal?.addEventListener(
                "abort",
                () => {
                  try {
                    controller.close();
                  } catch {
                    // Already closed by teardown; nothing to do.
                  }
                },
                { once: true }
              );
            }
          })
        } as never;
      }
      parts.push({
        type: "finish",
        finishReason: steps.length > 0 ? "tool-calls" : "stop",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          }
        })
      } as never;
    }
  });
}

/** An `AppConfig` shaped like the real one, with the tier-2 tools switched off. */
export function testConfig(): AppConfig {
  const chain = [
    { provider: "gemini" as const, model: "gemini-2.0-flash", keySource: "none" as const, contextLimit: 65536 }
  ];
  return {
    countryCode: "IN",
    currency: "INR",
    dbPath: ":memory:",
    theme: "sage-dark",
    personality: "helpful-consultant",
    tier2Enabled: false,
    freeformConsultEnabled: false,
    search: { provider: "none", crawlEnabled: false },
    llm: { roles: { chat: chain, subagent: chain, scraper: chain }, chain }
  } as AppConfig;
}

/**
 * Run the real `streamChat` and collect the UI messages the browser would have
 * received. `abortAfterCall` aborts once the Nth model call has been dispatched,
 * which is how a tab closed mid-stream leaves a tool call with no output.
 */
export async function runChatToUiMessages(
  streamChat: typeof import("@/lib/llm/chat-engine").streamChat,
  options: {
    messages: unknown[];
    sessionId?: string;
    abortAfterCall?: number;
    onModelCall?: (call: number) => void;
  }
): Promise<UIMessage[]> {
  const collected: UIMessage[] = [];
  const controller = new AbortController();
  const result = await streamChat(
    testConfig(),
    options.messages as never,
    options.sessionId,
    controller.signal
  );

  const uiStream = result.toUIMessageStream({ originalMessages: [] as never });
  try {
    for await (const message of readUIMessageStream({ stream: uiStream })) {
      collected.push(message);
      if (options.abortAfterCall && collected.length >= options.abortAfterCall) controller.abort();
    }
  } catch {
    // An abort mid-stream is the condition under test, not a failure.
  }
  return collected;
}
