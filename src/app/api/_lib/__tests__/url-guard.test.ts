import { describe, expect, it } from "vitest";
import { assertSafeFetchUrl, UnsafeUrlError } from "../url-guard";

describe("assertSafeFetchUrl", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://localhost/profile.json",
    "http://127.0.0.1/profile.json",
    "http://10.0.0.1/profile.json",
    "http://172.16.0.1/profile.json",
    "http://192.168.1.1/profile.json",
    "http://[::1]/profile.json",
    "http://[fc00::1]/profile.json",
    "http://[fe80::1]/profile.json",
    "https://user:pass@example.com/profile.json",
    "ftp://example.com/profile.json"
  ])("rejects unsafe URL %s", (url) => {
    expect(() => assertSafeFetchUrl(url)).toThrow(UnsafeUrlError);
  });

  it("allows public http and https URLs", () => {
    expect(assertSafeFetchUrl("https://raw.githubusercontent.com/openai/openai-node/master/README.md").hostname).toBe("raw.githubusercontent.com");
  });
});
