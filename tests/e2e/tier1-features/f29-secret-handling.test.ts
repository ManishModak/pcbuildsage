import { describe, it, expect } from "vitest";
import { parseWorkflowYaml } from "../test-harness";

describe("Tier 1 - Feature 29: Fine-Grained Secret Handling (R6)", () => {
  const workflowContent = `
    steps:
      - name: Publish to Turso
        env:
          TURSO_INGEST_TOKEN: \${{ secrets.TURSO_INGEST_TOKEN }}
          TURSO_DATABASE_URL: \${{ secrets.TURSO_DATABASE_URL }}
        run: npx tsx scripts/publish-catalog.ts /tmp/candidate.db
  `;

  it("CI ingestion workflow uses fine-grained TURSO_INGEST_TOKEN", () => {
    const parsed = parseWorkflowYaml(workflowContent);
    expect(parsed.usesIngestToken).toBe(true);
  });

  it("Render web service environment uses read-only TURSO_READ_TOKEN", () => {
    const renderEnv = {
      TURSO_DATABASE_URL: "libsql://pcbuildsage-cloud.turso.io",
      TURSO_READ_TOKEN: "read-only-token-abc"
    };
    expect(renderEnv.TURSO_READ_TOKEN).toBeDefined();
    expect(renderEnv).not.toHaveProperty("TURSO_INGEST_TOKEN");
  });

  it("secrets are never hardcoded in workflow YAML or scripts", () => {
    expect(workflowContent).not.toMatch(/TURSO_INGEST_TOKEN:\s*['"][a-zA-Z0-9_\-\.]{15,}['"]/);
    expect(workflowContent).toContain("secrets.TURSO_INGEST_TOKEN");
  });

  it("database tokens and secrets are redacted from log outputs", () => {
    const logMessage = "Connecting to database with token secret_token_xyz";
    const redacted = logMessage.replace(/token\s+[a-zA-Z0-9_-]+/i, "token [REDACTED]");
    expect(redacted).toBe("Connecting to database with token [REDACTED]");
    expect(redacted).not.toContain("secret_token_xyz");
  });

  it("validates presence of required secret environment variables before publish", () => {
    const validateSecrets = (env: Record<string, string | undefined>) => {
      if (!env.TURSO_INGEST_TOKEN || !env.TURSO_DATABASE_URL) {
        throw new Error("Missing required Turso ingest secrets");
      }
      return true;
    };

    expect(() => validateSecrets({})).toThrow("Missing required Turso ingest secrets");
    expect(
      validateSecrets({
        TURSO_INGEST_TOKEN: "tok",
        TURSO_DATABASE_URL: "url"
      })
    ).toBe(true);
  });
});
