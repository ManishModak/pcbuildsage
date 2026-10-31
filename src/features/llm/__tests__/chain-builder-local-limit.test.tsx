import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChainBuilder } from "../chain-builder";
import type { ChainEntry, CredentialAvailability, EndpointPreset } from "@/types/client";

describe("ChainBuilder local model context limit warning and entry", () => {
  const dummyCredentials: CredentialAvailability = {
    llm: { gemini: true, groq: false, openrouter: false },
    search: {}
  };

  const dummyEndpoints: EndpointPreset[] = [
    {
      name: "LM Studio",
      base_url: "http://localhost:1234/v1",
      requires_key: false,
      model_list_style: "openai"
    }
  ];

  it("shows warning and allows entering limit when local provider (ollama) has unknown context limit", () => {
    const entry: ChainEntry = {
      id: "entry-ollama-1",
      provider: "ollama",
      model: "llama3:latest",
      keySource: "none",
      baseUrl: "http://localhost:11434",
      contextLimit: undefined // unknown
    };

    const handleChange = vi.fn();
    const html = renderToStaticMarkup(
      <ChainBuilder
        chain={[entry]}
        onChange={handleChange}
        credentials={dummyCredentials}
        endpoints={dummyEndpoints}
      />
    );

    // Warning is prominently shown
    expect(html).toContain("Unknown context limit for local provider");
    expect(html).toContain('role="alert"');

    // Context limit input field is available to let user enter the limit
    expect(html).toContain("Context limit (tokens)");
    expect(html).toContain("Required: specify the context limit for this local model.");
    expect(html).toContain('type="number"');
  });

  it("shows warning when local provider is openai-compatible with unknown context limit", () => {
    const entry: ChainEntry = {
      id: "entry-compat-1",
      provider: "openai-compatible",
      model: "custom-local-model",
      keySource: "none",
      baseUrl: "http://localhost:8000/v1",
      contextLimit: undefined
    };

    const html = renderToStaticMarkup(
      <ChainBuilder
        chain={[entry]}
        onChange={vi.fn()}
        credentials={dummyCredentials}
        endpoints={dummyEndpoints}
      />
    );

    expect(html).toContain("Unknown context limit for local provider");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Context limit (tokens)");
  });

  it("hides warning when local provider context limit is known or entered", () => {
    const entry: ChainEntry = {
      id: "entry-ollama-2",
      provider: "ollama",
      model: "llama3:latest",
      keySource: "none",
      baseUrl: "http://localhost:11434",
      contextLimit: 8192 // known limit
    };

    const html = renderToStaticMarkup(
      <ChainBuilder
        chain={[entry]}
        onChange={vi.fn()}
        credentials={dummyCredentials}
        endpoints={dummyEndpoints}
      />
    );

    // Warning is NOT displayed when limit is known
    expect(html).not.toContain("Unknown context limit for local provider");
    expect(html).not.toContain('role="alert"');

    // Context limit field displays configured value
    expect(html).toContain("Context limit (tokens)");
    expect(html).toContain('value="8192"');
    expect(html).toContain("Configured context window in tokens.");
  });

  it("does not show local unknown limit warning for cloud providers (e.g. Gemini)", () => {
    const entry: ChainEntry = {
      id: "entry-gemini-1",
      provider: "gemini",
      model: "gemini-2.0-flash",
      keySource: "env"
    };

    const html = renderToStaticMarkup(
      <ChainBuilder
        chain={[entry]}
        onChange={vi.fn()}
        credentials={dummyCredentials}
        endpoints={dummyEndpoints}
      />
    );

    expect(html).not.toContain("Unknown context limit for local provider");
    expect(html).not.toContain("Context limit (tokens)");
  });
});
