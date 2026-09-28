import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  API_KEY_FAQS,
  API_KEY_FACTS,
  API_KEY_GUIDES,
  API_KEY_HELP_CHECKED_ON,
  FREE_LIMIT_COPY,
  KEY_REJECTED_COPY,
  allApiKeyHelpFacts,
  mapProviderErrorToPlainLanguage
} from "../api-key-help";
import { getErrorMessage, getErrorMessageText } from "@/lib/format";
import { FailoverPill } from "@/features/chat/failover-pill";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

describe("api-key-help sources", () => {
  it("gives every fact at least one source with a URL and a check date", () => {
    const facts = allApiKeyHelpFacts();
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.sources.length, `missing source: ${fact.text}`).toBeGreaterThan(0);
      for (const source of fact.sources) {
        expect(source.url.trim().length, `empty source url: ${fact.text}`).toBeGreaterThan(0);
        expect(source.checkedOn, `bad check date: ${fact.text}`).toMatch(DATE_PATTERN);
        expect(source.checkedOn, `stale check date: ${fact.text}`).toBe(API_KEY_HELP_CHECKED_ON);
      }
    }
  });

  it("lists Gemini first, then OpenRouter, with the key-page links", () => {
    expect(API_KEY_GUIDES.map((guide) => guide.id)).toEqual(["gemini", "openrouter"]);
    expect(API_KEY_GUIDES[0].keyUrl).toBe("https://aistudio.google.com/app/apikey");
    expect(API_KEY_GUIDES[1].keyUrl).toBe("https://openrouter.ai/keys");
    for (const guide of API_KEY_GUIDES) {
      expect(guide.steps.length).toBeGreaterThan(0);
    }
    expect(API_KEY_FACTS.length).toBeGreaterThan(0);
    expect(API_KEY_FAQS.length).toBeGreaterThan(0);
  });

  it("never calls any build 'best'", () => {
    const texts = allApiKeyHelpFacts().map((fact) => fact.text);
    for (const text of texts) {
      expect(text, `forbidden wording: ${text}`).not.toMatch(/\bbest\b/i);
    }
  });
});

describe("mapProviderErrorToPlainLanguage", () => {
  it("maps 401/403 to the exact rejected-key copy", () => {
    expect(mapProviderErrorToPlainLanguage({ status: 401 })).toBe(KEY_REJECTED_COPY);
    expect(mapProviderErrorToPlainLanguage({ status: 403 })).toBe(KEY_REJECTED_COPY);
    expect(mapProviderErrorToPlainLanguage({ message: "[HTTP 401] Unauthorized" })).toBe(KEY_REJECTED_COPY);
    expect(mapProviderErrorToPlainLanguage({ message: "Invalid API key provided" })).toBe(KEY_REJECTED_COPY);
    expect(KEY_REJECTED_COPY).toBe("Your key was rejected. Check you copied all of it.");
  });

  it("maps 429 to the exact free-limit copy", () => {
    expect(mapProviderErrorToPlainLanguage({ status: 429 })).toBe(FREE_LIMIT_COPY);
    expect(mapProviderErrorToPlainLanguage({ message: "429 Too Many Requests" })).toBe(FREE_LIMIT_COPY);
    expect(mapProviderErrorToPlainLanguage({ message: "free-models-per-day quota exhausted" })).toBe(FREE_LIMIT_COPY);
    expect(FREE_LIMIT_COPY).toBe("You've hit the free limit. Wait a bit or pick another free model.");
  });

  it("returns undefined for unrelated failures", () => {
    expect(mapProviderErrorToPlainLanguage({ message: "Custom hardware failure code 99" })).toBeUndefined();
    expect(mapProviderErrorToPlainLanguage({ status: 503, message: "Service Unavailable" })).toBeUndefined();
    expect(mapProviderErrorToPlainLanguage({})).toBeUndefined();
  });
});

describe("chat UI provider-error copy", () => {
  it("shows the rejected-key copy for 401 inputs", () => {
    expect(getErrorMessageText("[HTTP 401] Unauthorized: invalid API key")).toContain(KEY_REJECTED_COPY);
    expect(getErrorMessage(new Error("API request failed with status 403 Forbidden"))).toContain(KEY_REJECTED_COPY);
  });

  it("shows the free-limit copy for 429 inputs", () => {
    expect(getErrorMessageText("[HTTP 429] Rate limit reached for model example:free")).toContain(FREE_LIMIT_COPY);
    expect(getErrorMessage(new Error("429 Too Many Requests: quota exceeded"))).toContain(FREE_LIMIT_COPY);
  });

  it("renders the new copy in the failover pill for 401/429 primary errors", () => {
    // renderToStaticMarkup escapes apostrophes (' → &#x27;); decode before
    // asserting so the test proves the exact user-facing copy appears.
    const decode = (html: string) => html.replace(/&#x27;/g, "'");
    const rejected = decode(
      renderToStaticMarkup(
        <FailoverPill meta={{ provider: "gemini", model: "gemini-2.5-flash", fallbackIndex: 1, primaryError: "[HTTP 401] Unauthorized" }} />
      )
    );
    expect(rejected).toContain(KEY_REJECTED_COPY);

    const limited = decode(
      renderToStaticMarkup(
        <FailoverPill meta={{ provider: "openrouter", model: "example:free", fallbackIndex: 1, primaryError: "[HTTP 429] Too Many Requests" }} />
      )
    );
    expect(limited).toContain(FREE_LIMIT_COPY);
  });
});
