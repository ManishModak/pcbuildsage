import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceControl, ChoiceGroup, Field, Input } from "../primitives";

describe("accessible form primitives", () => {
  it("associates a field label, hint, and error with its control", () => {
    const markup = renderToStaticMarkup(
      <Field label="API key" hint="Stored locally." error="A key is required.">
        {(controlProps) => <Input {...controlProps} />}
      </Field>
    );

    expect(markup).toMatch(/<label for="([^"]+)"[\s\S]*<input[^>]*id="\1"/);
    expect(markup).toMatch(/<input[^>]*id="([^"]+)"[^>]*aria-describedby="\1-hint \1-error"/);
    expect(markup).toMatch(/<input[^>]*id="([^"]+)"[^>]*aria-errormessage="\1-error"/);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toMatch(/<p id="([^"]+)-hint"/);
    expect(markup).toMatch(/<p id="([^"]+)-error" role="alert"/);
  });

  it("renders grouped native radio controls", () => {
    const markup = renderToStaticMarkup(
      <ChoiceGroup label="Personality">
        <ChoiceControl type="radio" name="personality" value="precise" checked readOnly>
          Precise
        </ChoiceControl>
        <ChoiceControl type="radio" name="personality" value="friendly" readOnly>
          Friendly
        </ChoiceControl>
      </ChoiceGroup>
    );

    expect(markup).toContain("<fieldset");
    expect(markup).toContain("<legend");
    expect(markup).toContain("Personality</legend>");
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup.match(/name="personality"/g)).toHaveLength(2);
    expect(markup).not.toContain('role="radio"');
  });
});
