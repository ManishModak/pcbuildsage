import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDockerfile } from "../e2e/test-harness";

describe("Container Verification - Next.js Standalone Dockerfile & .dockerignore", () => {
  const dockerfilePath = path.resolve(__dirname, "../../Dockerfile");
  const dockerignorePath = path.resolve(__dirname, "../../.dockerignore");

  it("verifies Dockerfile exists on disk and is readable", () => {
    expect(fs.existsSync(dockerfilePath)).toBe(true);
    const content = fs.readFileSync(dockerfilePath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("verifies 3 multi-stage build definitions (deps, builder, runner)", () => {
    const content = fs.readFileSync(dockerfilePath, "utf-8");
    const parsed = parseDockerfile(content);

    expect(parsed.isMultiStage).toBe(true);
    expect(parsed.stagesCount).toBe(3);

    // Verify each named stage in sequence
    const lines = content.split("\n").map((l) => l.trim());
    const fromLines = lines.filter((l) => /^FROM\s+/i.test(l));

    expect(fromLines).toHaveLength(3);
    expect(fromLines[0]).toMatch(/^FROM\s+node:20-bookworm-slim\s+AS\s+deps$/i);
    expect(fromLines[1]).toMatch(/^FROM\s+node:20-bookworm-slim\s+AS\s+builder$/i);
    expect(fromLines[2]).toMatch(/^FROM\s+node:20-bookworm-slim\s+AS\s+runner$/i);
  });

  it("verifies unprivileged user creation and non-root execution (USER nextjs)", () => {
    const content = fs.readFileSync(dockerfilePath, "utf-8");
    const parsed = parseDockerfile(content);

    expect(parsed.isNonRoot).toBe(true);
    expect(parsed.user).toBe("nextjs");

    // Verify system group and user creation with UID/GID 1001
    expect(content).toMatch(/groupadd\s+--system\s+--gid\s+1001\s+nodejs/);
    expect(content).toMatch(/useradd\s+--system\s+--uid\s+1001\s+--gid\s+nodejs\s+nextjs/);
    expect(content).toMatch(/^USER\s+nextjs$/m);
  });

  it("verifies NODE_ENV=production and telemetry disabled in runner stage", () => {
    const content = fs.readFileSync(dockerfilePath, "utf-8");
    const parsed = parseDockerfile(content);

    expect(parsed.isProductionEnv).toBe(true);
    expect(parsed.envVars["NODE_ENV"]).toBe("production");
    expect(content).toMatch(/ENV\s+NEXT_TELEMETRY_DISABLED=1/);
  });

  it("verifies standalone bundle copy directives (.next/standalone, .next/static, public, data)", () => {
    const content = fs.readFileSync(dockerfilePath, "utf-8");
    const parsed = parseDockerfile(content);

    expect(parsed.hasStandalone).toBe(true);

    // Verify standalone copy directives with proper nextjs:nodejs chown
    expect(content).toMatch(/COPY\s+--from=builder\s+--chown=nextjs:nodejs\s+\/app\/\.next\/standalone\s+\.\//);
    expect(content).toMatch(/COPY\s+--from=builder\s+--chown=nextjs:nodejs\s+\/app\/\.next\/static\s+\.\/\.next\/static/);
    expect(content).toMatch(/COPY\s+--from=builder\s+--chown=nextjs:nodejs\s+\/app\/public\s+\.\/public/);
    expect(content).toMatch(/COPY\s+--from=builder\s+--chown=nextjs:nodejs\s+\/app\/data\s+\.\/data/);
  });

  it("verifies dynamic port configuration (ENV PORT=10000, EXPOSE 10000, CMD ['node', 'server.js'])", () => {
    const content = fs.readFileSync(dockerfilePath, "utf-8");
    const parsed = parseDockerfile(content);

    expect(parsed.exposedPorts).toContain("10000");
    expect(parsed.envVars["PORT"]).toBe("10000");
    expect(parsed.envVars["HOSTNAME"]).toBe("0.0.0.0");

    expect(content).toMatch(/^EXPOSE\s+10000$/m);
    expect(content).toMatch(/^ENV\s+PORT=10000$/m);
    expect(content).toMatch(/^ENV\s+HOSTNAME=0\.0\.0\.0$/m);
    expect(content).toMatch(/^CMD\s+\["node",\s*"server\.js"\]$/m);
  });

  it("verifies .dockerignore exists and excludes required patterns", () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
    const content = fs.readFileSync(dockerignorePath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));

    expect(lines).toContain("node_modules");
    expect(lines).toContain(".next");
    expect(lines).toContain("data/*.db*");
    expect(lines).toContain("data/logs");
    expect(lines).toContain(".venv");
    expect(lines).toContain(".git");
    expect(lines).toContain("tests");
  });
});
