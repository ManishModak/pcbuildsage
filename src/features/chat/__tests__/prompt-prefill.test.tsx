import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../composer";
import { MAX_PREFILL_CHARS, readPromptPrefill, stripPromptParam } from "../prompt-prefill";
import { customiseUrl } from "../../../../scripts/build-guides";

describe("?prompt= prefill", () => {
  it("round-trips the guide's Customise link", () => {
    const url = new URL(customiseUrl({ budget: 50000, resolution: "1080p" }, "cpu: Ryzen 5 5600; gpu: RX 6600"));
    const text = readPromptPrefill(url.search);
    expect(text).toContain("Customise this 1080p gaming build under Rs. 50000");
    expect(text).toContain("gpu: RX 6600");
  });

  it("is empty without the param and caps long values", () => {
    expect(readPromptPrefill("?foo=1")).toBe("");
    expect(readPromptPrefill(`?prompt=${"a".repeat(MAX_PREFILL_CHARS + 50)}`)).toHaveLength(MAX_PREFILL_CHARS);
  });

  it("strips only the prompt param, via replaceState", () => {
    const replaceState = vi.fn();
    stripPromptParam({
      location: { href: "https://x.test/?prompt=hi&tab=llm#top" } as Location,
      history: { state: null, replaceState } as unknown as History
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?tab=llm#top");
  });

  it("prefills the composer without sending", () => {
    const onSend = vi.fn();
    const html = renderToStaticMarkup(
      <Composer onSend={onSend} onStop={() => {}} streaming={false} initialValue="Customise this build" />
    );
    expect(html).toContain(">Customise this build</textarea>");
    expect(onSend).not.toHaveBeenCalled();
  });
});
