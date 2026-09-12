import { describe, it, expect } from "vitest";
import { validateChatUrl } from "../test-harness";

describe("Tier 1 - Feature 3: LLM Provider SSRF Prevention (R1)", () => {
  it("permits standard official provider URLs in hosted-demo mode", () => {
    const google = validateChatUrl("https://generativelanguage.googleapis.com", "hosted-demo");
    expect(google.allowed).toBe(true);

    const openrouter = validateChatUrl("https://openrouter.ai/api/v1", "hosted-demo");
    expect(openrouter.allowed).toBe(true);

    const openai = validateChatUrl("https://api.openai.com/v1", "hosted-demo");
    expect(openai.allowed).toBe(true);
  });

  it("rejects private and internal IP addresses in hosted-demo mode", () => {
    const loopback = validateChatUrl("http://127.0.0.1:8000", "hosted-demo");
    expect(loopback.allowed).toBe(false);

    const awsMeta = validateChatUrl("http://169.254.169.254/latest/meta-data", "hosted-demo");
    expect(awsMeta.allowed).toBe(false);

    const private10 = validateChatUrl("https://10.0.0.1/api", "hosted-demo");
    expect(private10.allowed).toBe(false);

    const private192 = validateChatUrl("https://192.168.1.50/llm", "hosted-demo");
    expect(private192.allowed).toBe(false);
  });

  it("rejects localhost and loopback hostnames in hosted-demo mode", () => {
    const localhost = validateChatUrl("http://localhost:3000/api", "hosted-demo");
    expect(localhost.allowed).toBe(false);

    const localDomain = validateChatUrl("https://server.local/chat", "hosted-demo");
    expect(localDomain.allowed).toBe(false);
  });

  it("rejects non-https protocols and arbitrary third-party endpoints in hosted-demo mode", () => {
    const ftp = validateChatUrl("ftp://generativelanguage.googleapis.com", "hosted-demo");
    expect(ftp.allowed).toBe(false);

    const arbitrary = validateChatUrl("https://untrusted-proxy.evil.com/api", "hosted-demo");
    expect(arbitrary.allowed).toBe(false);
  });

  it("permits custom local base URLs when running in local deployment mode", () => {
    const ollama = validateChatUrl("http://localhost:11434/v1", "local");
    expect(ollama.allowed).toBe(true);

    const lmstudio = validateChatUrl("http://127.0.0.1:1234/v1", "local");
    expect(lmstudio.allowed).toBe(true);
  });
});
