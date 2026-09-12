import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { appendChatLog } from "../logger";

describe("appendChatLog", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
  });

  it("skips file logging in hosted-demo mode", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const mkdirSpy = vi.spyOn(fs, "mkdir");
    const appendSpy = vi.spyOn(fs, "appendFile");

    await appendChatLog({ role: "user", content: "test message", session_id: "sess-1" });

    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("safely ignores EACCES filesystem errors without throwing", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
    vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("EACCES: permission denied, mkdir '/app/logs'"));

    // Should resolve cleanly without throwing unhandled rejection
    await expect(
      appendChatLog({ role: "user", content: "test message", session_id: "sess-2" })
    ).resolves.toBeUndefined();
  });
});
