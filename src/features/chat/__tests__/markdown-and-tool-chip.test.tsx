import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../markdown";
import { ToolChip } from "../tool-chip";

describe("Markdown tables", () => {
  const table = "| Part | Price |\n| --- | --- |\n| Ryzen 5 5600 | ₹12,499 |\n| B550 board | ₹9,999 |";

  it("right-aligns price columns in mono and leaves text columns alone", () => {
    const html = renderToStaticMarkup(<Markdown text={table} />);
    const cells = html.match(/<td[^>]*>/g) ?? [];
    expect(cells).toHaveLength(4);
    expect(cells[0]).not.toContain("text-right");
    expect(cells[1]).toContain("text-right");
    expect(cells[1]).toContain("font-mono");
    expect(html.match(/<th [^>]*>/g)?.[1]).toContain("text-right");
  });

  it("does not treat a column with words in it as numeric", () => {
    const html = renderToStaticMarkup(<Markdown text={"| Part | Note |\n| --- | --- |\n| CPU | 12 cores |"} />);
    expect(html).not.toContain("text-right");
  });
});

describe("Markdown streaming runes", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  it("draws only the newest blocks of a streaming reply as rune letters, with the text intact", () => {
    const reply = "First block.\n\nSecond **block**.\n\nThird  block";
    const html = renderToStaticMarkup(<Markdown text={reply} streaming />);
    const paragraphs = html.match(/<p>.*?<\/p>/g) ?? [];
    expect(paragraphs[0]).not.toContain("rune-ch");
    expect(paragraphs[1]).toContain("rune-ch");
    expect(paragraphs[2]).toContain("rune-ch");
    // One real space per run, as HTML would collapse it.
    expect(text(paragraphs[2])).toBe("Third block");
    expect(text(paragraphs[1])).toBe("Second block.");
  });

  it("draws a finished reply as plain text", () => {
    expect(renderToStaticMarkup(<Markdown text={"Done.\n\nAll of it."} />)).not.toContain("rune-ch");
  });
});

describe("ToolChip status", () => {
  it("shows the rune spinner while running and a status icon once done", () => {
    const running = renderToStaticMarkup(<ToolChip part={{ type: "tool-search_products", state: "input-available" }} />);
    expect(running).toContain("rune-spinner");
    const done = renderToStaticMarkup(
      <ToolChip part={{ type: "tool-search_products", state: "output-available", output: { results: [1, 2] } }} />
    );
    expect(done).not.toContain("rune-spinner");
    expect(done).toContain("2 results");
  });

  it("marks a failed call with text as well as colour", () => {
    const failed = renderToStaticMarkup(
      <ToolChip part={{ type: "tool-validate_build", state: "output-error", errorText: "boom" }} />
    );
    expect(failed).toContain("error");
    expect(failed).toContain("text-blocking");
  });
});
