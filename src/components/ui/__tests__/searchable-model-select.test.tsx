import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SearchableModelSelect } from "../searchable-model-select";

describe("SearchableModelSelect", () => {
  const sampleModels = [
    { id: "anthropic/claude-3.5-sonnet", name: "Anthropic: Claude 3.5 Sonnet" },
    { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek: DeepSeek Chat" },
    { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2 (free)" }
  ];

  it("renders trigger button with selected model name and mono ID", () => {
    const markup = renderToStaticMarkup(
      <SearchableModelSelect
        value="anthropic/claude-3.5-sonnet"
        onChange={vi.fn()}
        models={sampleModels}
        providerId="openrouter"
        data-testid="model-select-test"
      />
    );

    expect(markup).toContain("Anthropic: Claude 3.5 Sonnet");
    expect(markup).toContain("anthropic/claude-3.5-sonnet");
    expect(markup).toContain("data-testid=\"model-select-test\"");
    expect(markup).toContain("aria-haspopup=\"listbox\"");
  });

  it("falls back to value or placeholder if model name is not in list", () => {
    const markup = renderToStaticMarkup(
      <SearchableModelSelect
        value="custom/unlisted-model"
        onChange={vi.fn()}
        models={sampleModels}
        providerId="openrouter"
      />
    );

    expect(markup).toContain("custom/unlisted-model");
  });

  it("supports disabled state", () => {
    const markup = renderToStaticMarkup(
      <SearchableModelSelect
        value="anthropic/claude-3.5-sonnet"
        onChange={vi.fn()}
        models={sampleModels}
        disabled
      />
    );

    expect(markup).toContain("disabled");
  });

  it("renders OpenRouter tag pills only when providerId is openrouter", () => {
    const openrouterMarkup = renderToStaticMarkup(
      <SearchableModelSelect
        value="anthropic/claude-3.5-sonnet"
        onChange={vi.fn()}
        models={sampleModels}
        providerId="openrouter"
        defaultOpen
      />
    );

    expect(openrouterMarkup).toContain("Claude");
    expect(openrouterMarkup).toContain("DeepSeek");
    expect(openrouterMarkup).toContain("Llama");
  });

  it("does not render OpenRouter tag pills for Gemini even with >20 models", () => {
    const manyGeminiModels = Array.from({ length: 30 }, (_, i) => ({
      id: `gemini-model-${i}`,
      name: `Gemini Model ${i}`
    }));

    const geminiMarkup = renderToStaticMarkup(
      <SearchableModelSelect
        value="gemini-model-0"
        onChange={vi.fn()}
        models={manyGeminiModels}
        providerId="gemini"
        defaultOpen
      />
    );

    expect(geminiMarkup).not.toContain("Claude");
    expect(geminiMarkup).not.toContain("DeepSeek");
    expect(geminiMarkup).not.toContain("Llama");
  });
});
