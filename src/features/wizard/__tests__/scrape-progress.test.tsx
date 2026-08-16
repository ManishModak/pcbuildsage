import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScrapeProgress, buildIssueUrl, type SiteRow } from "../scrape-progress";

describe("ScrapeProgress raw log component", () => {
  it("renders raw log component with copy button and line count", () => {
    const logs = ["line 1\n", "line 2\n", "line 3\n"];
    const markup = renderToStaticMarkup(
      <ScrapeProgress
        rows={[]}
        logs={logs}
        running={false}
      />
    );

    expect(markup).toContain("Raw log (3 lines)");
    expect(markup).toContain("copy");
    expect(markup).toContain('aria-label="Copy logs to clipboard"');
    expect(markup).toContain('title="Copy logs"');
    expect(markup).toContain("show");
  });

  it("disables copy button when logs are empty", () => {
    const markup = renderToStaticMarkup(
      <ScrapeProgress
        rows={[]}
        logs={[]}
        running={false}
      />
    );

    expect(markup).toContain("Raw log (0 lines)");
    expect(markup).toContain("disabled");
  });
});

describe("buildIssueUrl and failure rows", () => {
  it("generates a pre-filled GitHub issue URL with error and log snippet", () => {
    const row: SiteRow = {
      key: "kryptronix/cpu",
      site: "Kryptronix",
      category: "cpu",
      status: "failed",
      error: "invalid event type: sweep_skipped"
    };
    const logs = [
      "[INIT] Starting crawl\n",
      "[ERROR] Kryptronix failed: sweep_skipped\n"
    ];

    const url = buildIssueUrl(row, logs);
    expect(url).toContain("https://github.com/pcbuildsage/pcbuildsage/issues/new?");
    expect(url).toContain("%5BScraper+Failure%5D+Kryptronix%2Fcpu");
    expect(url).toContain("Kryptronix");
    expect(url).toContain("invalid+event+type%3A+sweep_skipped");
    expect(url).toContain("%5BERROR%5D+Kryptronix+failed%3A+sweep_skipped");
  });

  it("renders failure items with enhanced open issue link and without view log", () => {
    const row: SiteRow = {
      key: "kryptronix/cpu",
      site: "Kryptronix",
      category: "cpu",
      status: "failed",
      error: "invalid event type: sweep_skipped"
    };

    const markup = renderToStaticMarkup(
      <ScrapeProgress
        rows={[row]}
        logs={["[ERROR] Kryptronix/cpu failed\n"]}
        running={false}
      />
    );

    expect(markup).not.toContain("view log");
    expect(markup).toContain("open issue");
    expect(markup).toContain("https://github.com/pcbuildsage/pcbuildsage/issues/new?");
  });
});
