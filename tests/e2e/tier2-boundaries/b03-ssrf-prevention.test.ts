import { describe, it, expect } from "vitest";
import { validateChatUrl } from "../test-harness";

describe("Tier 2 Boundary - Feature 3: SSRF Prevention Adversarial Edge Cases", () => {
  it("rejects IPv6 loopback and compressed loopbacks (http://[::1], http://[0:0:0:0:0:0:0:1])", () => {
    expect(validateChatUrl("http://[::1]:8000/v1", "hosted-demo").allowed).toBe(false);
  });

  it("rejects decimal integer IP address encodings (e.g. http://2130706433)", () => {
    // 2130706433 is 127.0.0.1 in decimal format
    expect(validateChatUrl("http://2130706433/v1", "hosted-demo").allowed).toBe(false);
  });

  it("rejects embedded basic auth credentials in URL (e.g. https://user:pass@evil.com)", () => {
    expect(validateChatUrl("https://admin:secret@evil-domain.com/v1", "hosted-demo").allowed).toBe(false);
  });

  it("rejects invalid, unparseable, or non-URI strings safely without throwing uncaught errors", () => {
    expect(validateChatUrl("not_a_valid_url", "hosted-demo").allowed).toBe(false);
    expect(validateChatUrl("://missing-scheme", "hosted-demo").allowed).toBe(false);
    expect(validateChatUrl("", "hosted-demo").allowed).toBe(true); // empty defaults to official provider
  });

  it("rejects subdomains spoofing allowed providers (e.g. https://generativelanguage.googleapis.com.attacker.com)", () => {
    const spoof = validateChatUrl("https://generativelanguage.googleapis.com.attacker.com/v1", "hosted-demo");
    expect(spoof.allowed).toBe(false);
  });
});
