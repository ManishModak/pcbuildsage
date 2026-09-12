import { describe, it, expect } from "vitest";
import { getErrorMessageText, getErrorMessage } from "../format";

describe("Error Diagnostics & Classification", () => {
  it("accurately classifies explicit context length overflow when upstream indicates it", () => {
    const errorWithContext = JSON.stringify({
      error: {
        message: "This model's maximum context length is 32768 tokens. However, your messages resulted in 45120 tokens.",
        code: "context_length_exceeded"
      }
    });

    const formatted = getErrorMessageText(errorWithContext);
    expect(formatted).toContain("Context length limit exceeded");
    expect(formatted).toContain("45120 tokens");
    expect(formatted).toContain("Try starting a new chat or narrowing search filters");
  });

  it("classifies rate limit / quota exceeded errors accurately", () => {
    const rateLimitError = "HTTP 429: Rate limit exceeded: free-tier limit 20 requests per minute";
    const formatted = getErrorMessageText(rateLimitError);
    expect(formatted).toContain("Rate limit or quota reached (HTTP 429)");
    expect(formatted).toContain("wait a moment before trying again");
  });

  it("does NOT diagnose generic HTTP 400 as context overflow without upstream evidence", () => {
    // Unexplained provider rejection
    const generic400 = "[HTTP 400] Provider returned error";
    const formatted = getErrorMessageText(generic400);

    // Must NOT falsely claim context overflow
    expect(formatted).not.toContain("Context length limit exceeded");
    expect(formatted).not.toContain("too long for this model's context window");

    // Must report unexplained provider rejection
    expect(formatted).toContain("The model provider returned an error");
    expect(formatted).toContain("likely rate limit, timeout, or service interruption");
  });

  it("handles 503 service overloaded errors", () => {
    const err503 = "HTTP 503 Service Unavailable: Model is overloaded";
    const formatted = getErrorMessageText(err503);
    expect(formatted).toContain("The model provider is temporarily overloaded or unavailable (HTTP 503)");
  });

  it("preserves underlying message when error shape is arbitrary text", () => {
    const customError = "Custom hardware failure code 99";
    const formatted = getErrorMessageText(customError);
    expect(formatted).toBe(customError);
  });

  it("extracts error message from Error object using getErrorMessage", () => {
    const err = new Error("Rate limit exceeded (HTTP 429)");
    expect(getErrorMessage(err)).toContain("Rate limit");
  });

  it("accurately classifies daily free-model quota exhaustion without suggesting to wait a moment", () => {
    const dailyQuotaError = JSON.stringify({
      error: {
        message: "Resource has been exhausted (e.g. check quota): free-models-per-day exceeded",
        code: 429
      }
    });

    const formatted = getErrorMessageText(dailyQuotaError);
    expect(formatted).toContain("The provider reports that its daily free-model quota is exhausted");
    expect(formatted).toContain("Try again after it resets, or check your provider settings");
    expect(formatted).not.toContain("wait a moment");
  });

  it("shows supplied reset timing details when present in daily quota response", () => {
    const dailyWithReset = "HTTP 429: free-models-per-day limit reached. Resets at 00:00 UTC";
    const formatted = getErrorMessageText(dailyWithReset);
    expect(formatted).toContain("The provider reports that its daily free-model quota is exhausted");
    expect(formatted).toContain("Resets at 00:00 UTC");
    expect(formatted).not.toContain("wait a moment");
  });
});
