import type { LanguageModelV4Content, LanguageModelV4Middleware, LanguageModelV4StreamPart } from "@ai-sdk/provider";

/**
 * Small models (Nemotron Lightning on NIM) sometimes answer a step with no
 * text and no tool call. The AI SDK loop ends on a step without tool calls,
 * so the turn stops blank mid-research. This middleware asks again once when
 * a step comes back empty; a second empty answer passes through unchanged.
 * Parts that came before the empty finish (reasoning, metadata) stay as sent.
 */
export const emptyStepRetryMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return result.content.some(isContent) ? result : doGenerate();
  },
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    let sawContent = false;
    const stream = result.stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        async transform(part, controller) {
          if (isContentPart(part)) sawContent = true;
          if (part.type !== "finish" || sawContent) {
            controller.enqueue(part);
            return;
          }
          let retry: ReadableStream<LanguageModelV4StreamPart>;
          try {
            retry = (await doStream()).stream;
          } catch {
            controller.enqueue(part);
            return;
          }
          const reader = retry.getReader();
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            if (next.value.type !== "stream-start") controller.enqueue(next.value);
          }
        }
      })
    );
    return { ...result, stream };
  }
};

function isContent(part: LanguageModelV4Content): boolean {
  return part.type === "tool-call" || (part.type === "text" && part.text.trim().length > 0);
}

function isContentPart(part: LanguageModelV4StreamPart): boolean {
  return (
    part.type === "tool-call" ||
    part.type === "tool-input-start" ||
    (part.type === "text-delta" && part.delta.trim().length > 0)
  );
}
