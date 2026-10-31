import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { base, run } from "./rules-helpers";

describe("rule: socket", () => {
  it("blocks mismatched CPU and motherboard sockets", () => {
    const result = run({ motherboard: makeResolved("mobo-lga", "motherboard", { ...base.motherboard.spec, socket: "LGA 1700" }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "socket" }));
  });
  it("requests research when socket fields are missing", () => {
    const result = run({ cpu: makeResolved("cpu-no-socket", "cpu", { ...base.cpu.spec, socket: undefined }) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
  });
    it("records truthful unverified check for socket when CPU is unregistered", () => {
      const motherboard = makeResolved("mobo-b650", "motherboard", { ...base.motherboard.spec, socket: "AM5" });
      const result = validateBuild(
        { cpu: "unregistered-cpu", motherboard: motherboard.key },
        { resolve: (part) => (part === motherboard.key ? motherboard : undefined) }
      );

      const socketCheck = result.checks.find((c) => c.rule === "socket");
      expect(socketCheck).toBeDefined();
      expect(socketCheck?.status).toBe("unverified");
      expect(socketCheck?.message).toBe(
        "CPU compatibility could not be verified from the available data. Check the motherboard’s CPU support list."
      );
      expect(result.valid).toBe(true); // Non-blocking
    });
});
