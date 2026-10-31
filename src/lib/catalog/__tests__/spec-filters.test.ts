import { describe, expect, it } from "vitest";
import { matchesSocket, matchesFormFactor, matchesDdr, canonicalizeSocket, canonicalizeFormFactor } from "../spec-filters";

describe("spec-filters", () => {
  describe("canonicalizeSocket and matchesSocket", () => {
    it("canonicalizes socket casing and whitespace", () => {
      expect(canonicalizeSocket("AM5")).toBe("am5");
      expect(canonicalizeSocket("LGA 1700")).toBe("lga1700");
      expect(canonicalizeSocket("lga-1700")).toBe("lga1700");
    });

    it("matches scalar socket on CPUs/motherboards", () => {
      const cpuSpec = { brand: "AMD", model: "7800X3D", aliases: [], socket: "AM5" };
      expect(matchesSocket(cpuSpec, "AM5")).toBe(true);
      expect(matchesSocket(cpuSpec, "am5")).toBe(true);
      expect(matchesSocket(cpuSpec, "LGA 1700")).toBe(false);
    });

    it("agrees on underscore and spaced socket spellings (LGA_1700)", () => {
      const cpuSpec = { brand: "Intel", model: "14900K", aliases: [], socket: "LGA_1700" };
      expect(matchesSocket(cpuSpec, "LGA 1700")).toBe(true);
      expect(matchesSocket(cpuSpec, "lga1700")).toBe(true);
      expect(canonicalizeSocket("LGA_1700")).toBe(canonicalizeSocket("LGA 1700"));
    });

    it("matches array sockets on coolers", () => {
      const coolerSpec = {
        brand: "Noctua",
        model: "NH-D15",
        aliases: [],
        sockets: ["AM4", "AM5", "LGA 1700", "LGA 1851"]
      };
      expect(matchesSocket(coolerSpec, "AM5")).toBe(true);
      expect(matchesSocket(coolerSpec, "am5")).toBe(true);
      expect(matchesSocket(coolerSpec, "lga1700")).toBe(true);
      expect(matchesSocket(coolerSpec, "LGA 1700")).toBe(true);
      expect(matchesSocket(coolerSpec, "TR4")).toBe(false);
    });
  });

  describe("canonicalizeFormFactor and matchesFormFactor", () => {
    it("canonicalizes form factor equivalents (mATX, Micro-ATX)", () => {
      expect(canonicalizeFormFactor("mATX")).toBe("micro-atx");
      expect(canonicalizeFormFactor("Micro-ATX")).toBe("micro-atx");
      expect(canonicalizeFormFactor("Micro ATX")).toBe("micro-atx");
      expect(canonicalizeFormFactor("uATX")).toBe("micro-atx");
    });

    it("strictly preserves distinction between ATX and E-ATX", () => {
      expect(canonicalizeFormFactor("ATX")).toBe("atx");
      expect(canonicalizeFormFactor("E-ATX")).toBe("e-atx");
      expect(canonicalizeFormFactor("Extended ATX")).toBe("e-atx");
      expect(canonicalizeFormFactor("ATX")).not.toBe(canonicalizeFormFactor("E-ATX"));
    });

    it("matches scalar form factor on motherboards across spelling variations", () => {
      const matxBoard = { brand: "MSI", model: "B650M", aliases: [], form_factor: "Micro-ATX" };
      expect(matchesFormFactor(matxBoard, "mATX")).toBe(true);
      expect(matchesFormFactor(matxBoard, "micro-atx")).toBe(true);
      expect(matchesFormFactor(matxBoard, "ATX")).toBe(false);
    });
    it("matches array form_factors on cases", () => {
      const atxCase = {
        brand: "Corsair",
        model: "4000D",
        aliases: [],
        form_factors: ["ATX", "Micro-ATX", "Mini-ITX"]
      };
      expect(matchesFormFactor(atxCase, "ATX")).toBe(true);
      expect(matchesFormFactor(atxCase, "atx")).toBe(true);
      expect(matchesFormFactor(atxCase, "mATX")).toBe(true);
      expect(matchesFormFactor(atxCase, "Micro-ATX")).toBe(true);
      expect(matchesFormFactor(atxCase, "E-ATX")).toBe(false);
    });

    it("keeps DTX distinct from Mini-DTX", () => {
      expect(canonicalizeFormFactor("DTX")).toBe("dtx");
      expect(canonicalizeFormFactor("Mini-DTX")).toBe("mini-dtx");
      expect(canonicalizeFormFactor("DTX")).not.toBe(canonicalizeFormFactor("Mini-DTX"));
      const dtxBoard = { brand: "ASUS", model: "DTX Board", aliases: [], form_factor: "DTX" };
      expect(matchesFormFactor(dtxBoard, "DTX")).toBe(true);
      expect(matchesFormFactor(dtxBoard, "Mini-DTX")).toBe(false);
    });

    it("maps mITX to Mini-ITX but leaves bare ITX distinct", () => {
      expect(canonicalizeFormFactor("mITX")).toBe("mini-itx");
      expect(canonicalizeFormFactor("Mini-ITX")).toBe("mini-itx");
      expect(canonicalizeFormFactor("ITX")).toBe("itx");
      expect(canonicalizeFormFactor("ITX")).not.toBe(canonicalizeFormFactor("Mini-ITX"));
      const miniItxBoard = { brand: "MSI", model: "B650I", aliases: [], form_factor: "Mini-ITX" };
      expect(matchesFormFactor(miniItxBoard, "mITX")).toBe(true);
      expect(matchesFormFactor(miniItxBoard, "ITX")).toBe(false);
    });

    it("keeps SFX distinct from SFX-L", () => {
      expect(canonicalizeFormFactor("SFX")).toBe("sfx");
      expect(canonicalizeFormFactor("SFX-L")).toBe("sfx-l");
      const sfxCase = { brand: "Cooler Master", model: "NR200", aliases: [], form_factors: ["SFX", "SFX-L"] };
      expect(matchesFormFactor(sfxCase, "SFX-L")).toBe(true);
      const sfxOnly = { brand: "Lian Li", model: "Q58", aliases: [], form_factors: ["SFX"] };
      expect(matchesFormFactor(sfxOnly, "SFX-L")).toBe(false);
    });
  });

  describe("matchesDdr", () => {
    it("matches scalar ddr case-insensitively", () => {
      const board = { brand: "MSI", model: "B650", aliases: [], ddr: "DDR5" };
      expect(matchesDdr(board, "DDR5")).toBe(true);
      expect(matchesDdr(board, "ddr5")).toBe(true);
      expect(matchesDdr(board, " DDR5 ")).toBe(true);
      expect(matchesDdr(board, "DDR4")).toBe(false);
    });

    it("matches CPU supported_memory arrays", () => {
      const cpu = { brand: "Intel", model: "14900K", aliases: [], supported_memory: ["DDR4", "DDR5"] };
      expect(matchesDdr(cpu, "DDR4")).toBe(true);
      expect(matchesDdr(cpu, "ddr5")).toBe(true);
      expect(matchesDdr(cpu, "DDR3")).toBe(false);
    });

    it("treats missing filter and blank input as no-op, unknown specs as non-matching", () => {
      const board = { brand: "MSI", model: "B650", aliases: [], ddr: "DDR5" };
      expect(matchesDdr(board, "")).toBe(true);
      expect(matchesDdr(board, "   ")).toBe(true);
      expect(matchesDdr(undefined, "")).toBe(true);
      expect(matchesDdr(undefined, "DDR5")).toBe(false);
      expect(matchesDdr({ brand: "X", model: "Y", aliases: [] }, "DDR5")).toBe(false);
    });
  });
});
