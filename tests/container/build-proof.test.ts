import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import nextConfig from "../../next.config";

describe("Next.js Standalone Build Proof & Configuration Verification", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const dockerfilePath = path.join(rootDir, "Dockerfile");
  const packageJsonPath = path.join(rootDir, "package.json");

  it("configures output: 'standalone' in next.config.ts", () => {
    expect(nextConfig.output).toBe("standalone");
  });

  it("designates better-sqlite3 as serverExternalPackages for standalone binary bundling", () => {
    expect(nextConfig.serverExternalPackages).toContain("better-sqlite3");
  });

  it("verifies package.json contains standard build and start scripts for standalone production", () => {
    const raw = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(raw);
    expect(pkg.scripts?.build).toBe("next build");
    expect(pkg.scripts?.start).toBe("next start");
  });

  it("verifies Dockerfile references server.js emitted by standalone build", () => {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    expect(dockerfile).toContain("COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./");
    expect(dockerfile).toMatch(/CMD\s+\["node",\s*"server\.js"\]/);
  });
});
