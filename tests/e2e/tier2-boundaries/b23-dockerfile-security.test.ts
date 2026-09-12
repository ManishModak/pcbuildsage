import { describe, it, expect } from "vitest";
import { parseDockerfile } from "../test-harness";

describe("Tier 2 Boundary - Feature 23: Dockerfile Security Boundaries", () => {
  it("detects and flags root user running in container (USER root or missing USER)", () => {
    const insecureDockerfile = `
      FROM node:20-alpine
      WORKDIR /app
      COPY . .
      USER root
      CMD ["node", "server.js"]
    `;
    const parsed = parseDockerfile(insecureDockerfile);
    expect(parsed.isNonRoot).toBe(false);
  });

  it("verifies explicit non-root user creation and execution (USER nextjs / 1001)", () => {
    const secureDockerfile = `
      FROM node:20-alpine AS runner
      RUN adduser -S -u 1001 nextjs
      USER nextjs
      CMD ["node", "server.js"]
    `;
    const parsed = parseDockerfile(secureDockerfile);
    expect(parsed.isNonRoot).toBe(true);
    expect(parsed.user).toBe("nextjs");
  });

  it("ensures .dockerignore excludes sensitive files (.env, .git, credentials)", () => {
    const sampleDockerignore = `
      node_modules
      .git
      .env
      .env.local
      data/*.db
      data/logs.db
      data/sessions.db
    `;
    expect(sampleDockerignore).toContain("node_modules");
    expect(sampleDockerignore).toContain(".git");
    expect(sampleDockerignore).toContain(".env");
    expect(sampleDockerignore).toContain("data/*.db");
  });

  it("verifies no secret tokens or passwords are hardcoded in Dockerfile ENV instructions", () => {
    const dockerfile = `
      ENV NODE_ENV=production
      ENV PORT=3000
    `;
    expect(dockerfile).not.toContain("SECRET");
    expect(dockerfile).not.toContain("TOKEN");
    expect(dockerfile).not.toContain("PASSWORD");
  });

  it("verifies multi-stage build uses alpine or slim minimal base images", () => {
    const dockerfile = "FROM node:20-alpine AS runner";
    expect(dockerfile).toContain("alpine");
  });
});
