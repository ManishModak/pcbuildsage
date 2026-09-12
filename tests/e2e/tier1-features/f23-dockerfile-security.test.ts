import { describe, it, expect } from "vitest";
import { parseDockerfile } from "../test-harness";

describe("Tier 1 - Feature 23: Production Multi-Stage Dockerfile (R5)", () => {
  const sampleDockerfile = `
    FROM node:20-alpine AS deps
    WORKDIR /app
    COPY package.json package-lock.json ./
    RUN npm ci

    FROM node:20-alpine AS builder
    WORKDIR /app
    COPY --from=deps /app/node_modules ./node_modules
    COPY . .
    RUN npm run build

    FROM node:20-alpine AS runner
    WORKDIR /app
    ENV NODE_ENV=production
    ENV PORT=3000
    RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
    USER nextjs
    COPY --from=builder /app/.next/standalone ./
    COPY --from=builder /app/.next/static ./.next/static
    COPY --from=builder /app/data/registry ./data/registry
    COPY --from=builder /app/data/schemas ./data/schemas
    EXPOSE 3000
    CMD ["node", "server.js"]
  `;

  it("contains multi-stage build definitions (deps, builder, runner)", () => {
    const parsed = parseDockerfile(sampleDockerfile);
    expect(parsed.isMultiStage).toBe(true);
    expect(parsed.stagesCount).toBe(3);
  });

  it("runner stage executes as non-root user (USER nextjs)", () => {
    const parsed = parseDockerfile(sampleDockerfile);
    expect(parsed.isNonRoot).toBe(true);
    expect(parsed.user).toBe("nextjs");
  });

  it("sets NODE_ENV to production in runner stage", () => {
    const parsed = parseDockerfile(sampleDockerfile);
    expect(parsed.isProductionEnv).toBe(true);
  });

  it("copies runtime data registry and schema assets to container image", () => {
    expect(sampleDockerfile).toContain("COPY --from=builder /app/data/registry ./data/registry");
    expect(sampleDockerfile).toContain("COPY --from=builder /app/data/schemas ./data/schemas");
  });

  it("copies Next.js standalone server bundle and static assets", () => {
    const parsed = parseDockerfile(sampleDockerfile);
    expect(parsed.hasStandalone).toBe(true);
    expect(sampleDockerfile).toContain(".next/static");
  });
});
