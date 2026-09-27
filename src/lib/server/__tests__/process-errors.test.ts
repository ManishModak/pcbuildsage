import { describe, expect, it } from "vitest";
import { crawlUnavailableMessage, isMissingBrowserError } from "../process-errors";

describe("process-errors", () => {
  describe("isMissingBrowserError", () => {
    it("recognizes executable/install evidence as a missing browser", () => {
      expect(isMissingBrowserError("Executable doesn't exist at /root/.cache/ms-playwright")).toBe(true);
      expect(isMissingBrowserError("Please run playwright install to install browsers")).toBe(true);
    });

    it("does not treat a mere Chromium mention as a missing browser", () => {
      // A crash, timeout, or launch failure can name Chromium without meaning
      // the browser is absent; those stay verbatim for diagnosis.
      expect(isMissingBrowserError("Chromium is missing")).toBe(false);
      expect(isMissingBrowserError("Chromium crashed after GPU process timeout")).toBe(false);
      expect(isMissingBrowserError("Target crashed: chromium revision unavailable? no - crashed")).toBe(false);
    });

    it("handles empty input", () => {
      expect(isMissingBrowserError(undefined)).toBe(false);
      expect(isMissingBrowserError("")).toBe(false);
    });
  });

  describe("crawlUnavailableMessage", () => {
    it("shares one message with and without an explicit reason", () => {
      expect(crawlUnavailableMessage()).toBe("Page crawling unavailable: Chromium is missing. Web search is available.");
      expect(crawlUnavailableMessage("timed out")).toBe("Page crawling unavailable: timed out. Web search is available.");
    });
  });
});
