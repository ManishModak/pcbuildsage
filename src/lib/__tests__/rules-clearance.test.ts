import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { resolveComponent } from "../registry";
import { base, run } from "./rules-helpers";

describe("rule: clearance", () => {
  it("blocks GPU, cooler, and motherboard physical clearance failures", () => {
    expect(run({ gpu: makeResolved("gpu-long", "gpu", { ...base.gpu.spec, length_mm: 400 }) }).issues).toContainEqual(expect.objectContaining({ rule: "clearance", severity: "blocking" }));
    expect(run({ cooler: makeResolved("cooler-tall", "cooler", { ...base.cooler.spec, height_mm: 190 }) }).issues).toContainEqual(expect.objectContaining({ rule: "clearance", severity: "blocking" }));
    expect(run({ case: makeResolved("case-itx", "case", { ...base.case.spec, form_factors: ["Mini-ITX"] }) }).issues).toContainEqual(expect.objectContaining({ rule: "clearance", severity: "blocking" }));
  });
  it("marks GPU clearance unverified with needs_verification when clearance fields are missing", () => {
    const result = run({ case: makeResolved("case-no-clearance", "case", { ...base.case.spec, max_gpu_length_mm: undefined }) });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: "needs_verification",
        rule: "clearance",
        detail: "GPU fit couldn’t be verified. Please check the card’s length against the case’s GPU clearance before buying."
      })
    );
    expect(result.valid).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        rule: "clearance",
        status: "unverified",
        message: "GPU fit couldn’t be verified. Please check the card’s length against the case’s GPU clearance before buying."
      })
    );
  });
  it("[r3] checkClearance produces unverified check when case max_gpu_length is low-confidence placeholder", () => {
    const pcCase = makeResolved("case-placeholder", "case", {
      brand: "Generic",
      model: "Placeholder Case",
      aliases: ["Placeholder Case"],
      max_gpu_length_mm: 400
    }, "low", "registry"); // Untrusted spec

    const gpu = makeResolved("gpu-exact", "gpu", {
      brand: "NVIDIA",
      model: "RTX 4070",
      aliases: ["RTX 4070"],
      length_mm: 260
    }, "high", "registry");

    const result = validateBuild(
      { case: pcCase.key, gpu: gpu.key },
      { resolve: (part) => (part === pcCase.key ? pcCase : part === gpu.key ? gpu : undefined) }
    );
    expect(result.valid).toBe(true);
    const clearanceCheck = result.checks.find((c) => c.rule === "clearance");
    expect(clearanceCheck?.status).toBe("unverified");
    expect(result.summary.unverified).toBeGreaterThanOrEqual(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("unsourced placeholder specs") })
    );
  });
      it.each(["Example 360 AIO with 120mm fans", "Corsair H170 AIO"])(
        "leaves radiator fit unverified without a size spec: %s",
        (model) => {
          const result = run({
            cooler: makeResolved("aio-without-size", "cooler", {
              ...base.cooler.spec, model, aliases: [model], cooler_type: "aio"
            }),
            case: makeResolved("case-120", "case", {
              ...base.case.spec, supported_radiators: [120]
            })
          });
          const clearance = result.checks.filter((check) =>
            check.rule === "clearance" && check.components.includes("aio-without-size")
          );
          expect(clearance).toHaveLength(1);
          expect(clearance[0].status).toBe("unverified");
          expect(clearance[0].message).toContain("radiator nominal size is unknown");
          expect(result.valid).toBe(true);
        }
      );
      it("fails when an AIO cooler radiator exceeds the case supported radiator sizes", () => {
        const cooler = makeResolved("arctic-liquid-freezer-iii-pro-420", "cooler", {
          brand: "Arctic",
          model: "Arctic Liquid Freezer III Pro 420",
          cooler_type: "aio",
          radiator_size_mm: 420,
          height_mm: 68.5,
          sockets: ["AM5", "LGA 1700"],
          tdp_rating_w: 350,
          aliases: ["Liquid Freezer III Pro 420"]
        });
        const pcCase = makeResolved("cooler-master-masterbox-q300l", "case", {
          brand: "Cooler Master",
          model: "Cooler Master MasterBox Q300L",
          max_cooler_height_mm: 159,
          max_gpu_length_mm: 360,
          supported_radiators: [120, 240],
          form_factors: ["Micro-ATX", "Mini-ITX"],
          aliases: ["MasterBox Q300L"]
        });

        const result = validateBuild(
          { cooler: cooler.key, case: pcCase.key },
          { resolve: (part) => (part === cooler.key ? cooler : part === pcCase.key ? pcCase : undefined) }
        );

        const clearanceCheck = result.checks.find(
          (c) => c.rule === "clearance" && c.components.includes(cooler.key) && c.components.includes(pcCase.key)
        );
        expect(clearanceCheck?.status).toBe("failed");
        expect(clearanceCheck?.message).toContain("Radiator size 420mm is not supported by case");
      });
      it("passes within checked scope when an AIO radiator matches supported case sizes", () => {
        const cooler = makeResolved("arctic-liquid-freezer-iii-240", "cooler", {
          brand: "Arctic",
          model: "Arctic Liquid Freezer III 240",
          cooler_type: "aio",
          radiator_size_mm: 240,
          height_mm: 68.5,
          sockets: ["AM5", "LGA 1700"],
          tdp_rating_w: 250,
          aliases: ["Liquid Freezer III 240"]
        });
        const pcCase = makeResolved("cooler-master-masterbox-q300l", "case", {
          brand: "Cooler Master",
          model: "Cooler Master MasterBox Q300L",
          max_cooler_height_mm: 159,
          max_gpu_length_mm: 360,
          supported_radiators: [120, 240],
          form_factors: ["Micro-ATX", "Mini-ITX"],
          aliases: ["MasterBox Q300L"]
        });

        const result = validateBuild(
          { cooler: cooler.key, case: pcCase.key },
          { resolve: (part) => (part === cooler.key ? cooler : part === pcCase.key ? pcCase : undefined) }
        );

        const clearanceCheck = result.checks.find(
          (c) => c.rule === "clearance" && c.components.includes(cooler.key) && c.components.includes(pcCase.key)
        );
        expect(clearanceCheck?.status).toBe("passed");
        expect(clearanceCheck?.message).toContain("240mm radiator is supported by case");
        expect(clearanceCheck?.message).toContain("physical thickness and component clearances not verified");
      });
      it("reports unverified when case radiator mounting data is unknown for an AIO", () => {
        const cooler = makeResolved("arctic-liquid-freezer-iii-pro-420", "cooler", {
          brand: "Arctic",
          model: "Arctic Liquid Freezer III Pro 420",
          cooler_type: "aio",
          radiator_size_mm: 420,
          height_mm: 68.5,
          sockets: ["AM5", "LGA 1700"],
          tdp_rating_w: 350,
          aliases: ["Liquid Freezer III Pro 420"]
        });
        const pcCase = makeResolved("generic-case", "case", {
          brand: "Generic",
          model: "Generic Case",
          max_cooler_height_mm: 160,
          max_gpu_length_mm: 350,
          form_factors: ["ATX"],
          aliases: ["Generic Case"]
        });

        const result = validateBuild(
          { cooler: cooler.key, case: pcCase.key },
          { resolve: (part) => (part === cooler.key ? cooler : part === pcCase.key ? pcCase : undefined) }
        );

        const clearanceCheck = result.checks.find(
          (c) => c.rule === "clearance" && c.components.includes(cooler.key) && c.components.includes(pcCase.key)
        );
        expect(clearanceCheck?.status).toBe("unverified");
        expect(clearanceCheck?.message).toContain("Case supported radiator sizes are not specified");
      });
      it("keeps radiator clearance unverified without blocking failure when radiator specs are untrusted", () => {
        const cooler = makeResolved(
          "untrusted-aio",
          "cooler",
          {
            brand: "Generic",
            model: "Generic Liquid 360",
            cooler_type: "aio",
            radiator_size_mm: 360,
            aliases: ["Generic Liquid 360"]
          },
          "low"
        );
        const pcCase = makeResolved("cooler-master-masterbox-q300l", "case", {
          brand: "Cooler Master",
          model: "Cooler Master MasterBox Q300L",
          max_cooler_height_mm: 159,
          max_gpu_length_mm: 360,
          supported_radiators: [120, 240],
          form_factors: ["Micro-ATX", "Mini-ITX"],
          aliases: ["MasterBox Q300L"]
        });

        const result = validateBuild(
          { cooler: cooler.key, case: pcCase.key },
          { resolve: (part) => (part === cooler.key ? cooler : part === pcCase.key ? pcCase : undefined) }
        );

        const clearanceCheck = result.checks.find(
          (c) => c.rule === "clearance" && c.components.includes(cooler.key) && c.components.includes(pcCase.key)
        );
        expect(clearanceCheck?.status).toBe("unverified");
        expect(clearanceCheck?.message).toContain("couldn’t be verified due to low-confidence or untrusted specs");
        expect(result.valid).toBe(true);
      });
      it("does not falsely pass Corsair H150i against case air cooler clearance", () => {
        const h150i = resolveComponent("corsair-h150i-rgb");
        expect(h150i).toBeDefined();

        const smallCase = makeResolved("cooler-master-masterbox-q300l", "case", {
          brand: "Cooler Master",
          model: "Cooler Master MasterBox Q300L",
          max_cooler_height_mm: 159,
          max_gpu_length_mm: 360,
          supported_radiators: [120, 240],
          form_factors: ["Micro-ATX", "Mini-ITX"],
          aliases: ["MasterBox Q300L"]
        });

        const result = validateBuild(
          { cooler: h150i!.key, case: smallCase.key },
          { resolve: (part) => (part === h150i!.key ? h150i : part === smallCase.key ? smallCase : undefined) }
        );

        const clearanceCheck = result.checks.find(
          (c) => c.rule === "clearance" && c.components.includes(h150i!.key) && c.components.includes(smallCase.key)
        );
        expect(clearanceCheck?.status).toBe("failed");
        expect(clearanceCheck?.message).toContain("Radiator size 360mm is not supported by case");
      });
      it("does not falsely pass DeepCool LS720 against case air cooler clearance", () => {
        const ls720 = resolveComponent("deepcool-ls720");
        expect(ls720).toBeDefined();

        const smallCase = makeResolved("cooler-master-masterbox-q300l", "case", {
          brand: "Cooler Master",
          model: "Cooler Master MasterBox Q300L",
          max_cooler_height_mm: 159,
          max_gpu_length_mm: 360,
          supported_radiators: [120, 240],
          form_factors: ["Micro-ATX", "Mini-ITX"],
          aliases: ["MasterBox Q300L"]
        });

        const result = validateBuild(
          { cooler: ls720!.key, case: smallCase.key },
          { resolve: (part) => (part === ls720!.key ? ls720 : part === smallCase.key ? smallCase : undefined) }
        );

        const clearanceCheck = result.checks.find(
          (c) => c.rule === "clearance" && c.components.includes(ls720!.key) && c.components.includes(smallCase.key)
        );
        expect(clearanceCheck?.status).toBe("failed");
        expect(clearanceCheck?.message).toContain("Radiator size 360mm is not supported by case");
      });
      it("detects a sourced ATX-versus-SFX case constraint conflict", () => {
        const nr200 = makeResolved("cooler-master-nr200", "case", {
          brand: "Cooler Master",
          model: "Cooler Master NR200",
          max_gpu_length_mm: 330,
          max_cooler_height_mm: 155,
          form_factors: ["Mini-ITX"],
          supported_psu_form_factors: ["SFX", "SFX-L"],
          aliases: ["NR200"]
        });
        const atxPsu = makeResolved("psu-atx-750", "psu", {
          brand: "Corsair",
          model: "RM750e",
          wattage: 750,
          form_factor: "ATX",
          aliases: ["RM750e"]
        });

        const result = run({ case: nr200, psu: atxPsu });
        const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(atxPsu.key));
        expect(clearanceCheck?.status).toBe("failed");
        expect(clearanceCheck?.message).toContain("PSU form factor ATX is not supported by case (supported: SFX, SFX-L)");
        expect(result.valid).toBe(false);
      });
      it("passes when PSU form factor matches sourced case supported form factors", () => {
        const nr200 = makeResolved("cooler-master-nr200", "case", {
          brand: "Cooler Master",
          model: "Cooler Master NR200",
          max_gpu_length_mm: 330,
          max_cooler_height_mm: 155,
          form_factors: ["Mini-ITX"],
          supported_psu_form_factors: ["SFX", "SFX-L"],
          aliases: ["NR200"]
        });
        const sfxPsu = makeResolved("psu-sfx-750", "psu", {
          brand: "Corsair",
          model: "SF750",
          wattage: 750,
          form_factor: "SFX",
          aliases: ["SF750"]
        });

        const moboItx = makeResolved("mobo-itx", "motherboard", {
          brand: "ASUS",
          model: "ROG Strix B650E-I",
          socket: "AM5",
          ddr: "DDR5",
          form_factor: "Mini-ITX",
          m2_slots: 2,
          sata_ports: 2,
          aliases: ["B650E-I"]
        });

        const result = run({ case: nr200, psu: sfxPsu, motherboard: moboItx });
        const clearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(sfxPsu.key));
        expect(clearanceCheck?.status).toBe("passed");
        expect(clearanceCheck?.message).toContain("PSU form factor SFX fits case");
      });
      it("records unverified when case PSU form factor limits are un-sourced", () => {
        const genericCase = makeResolved("generic-case", "case", {
          brand: "Generic",
          model: "Case Without PSU Limits",
          max_gpu_length_mm: 350,
          max_cooler_height_mm: 160,
          form_factors: ["ATX"],
          aliases: ["Generic Case"]
        });
        const psu = makeResolved("psu-atx", "psu", {
          brand: "Corsair",
          model: "RM750e",
          wattage: 750,
          form_factor: "ATX",
          aliases: ["RM750e"]
        });

        const result = run({ case: genericCase, psu });
        const psuClearanceCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes(psu.key));
        expect(psuClearanceCheck?.status).toBe("unverified");
        expect(psuClearanceCheck?.message).toContain("PSU form factor fit couldn’t be verified against case");
        expect(result.valid).toBe(true);
      });
  it("leaves cooler fit unverified for unknown construction and pushes needs_research issue", () => {
    const result = run({
      cooler: makeResolved("cooler-unknown", "cooler", { brand: "Generic", model: "Mystery Cooler", aliases: ["Mystery"], height_mm: 60, sockets: ["AM5"], tdp_rating_w: 150 })
    });
    const coolerCheck = result.checks.find((c) => c.rule === "clearance" && c.components.includes("cooler-unknown"));
    expect(coolerCheck?.status).toBe("unverified");
    expect(coolerCheck?.message).toContain("construction is unknown");
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
    expect(result.valid).toBe(true);
  });
  it("passes cooler clearance for backfilled air cooler noctua-nh-d15 in case with enough height", () => {
    const nhD15 = resolveComponent("noctua-nh-d15");
    expect(nhD15).toBeDefined();
    expect(nhD15?.spec.cooler_type).toBe("air");

    const bigCase = makeResolved("case-big", "case", {
      brand: "Fractal Design",
      model: "Define 7",
      max_cooler_height_mm: 185,
      max_gpu_length_mm: 400,
      form_factors: ["ATX"],
      aliases: ["Define 7"]
    });

    const result = validateBuild(
      { cooler: nhD15!.key, case: bigCase.key },
      { resolve: (part) => (part === nhD15!.key ? nhD15 : part === bigCase.key ? bigCase : undefined) }
    );
    const clearanceCheck = result.checks.find(
      (c) => c.rule === "clearance" && c.components.includes(nhD15!.key)
    );
    expect(clearanceCheck?.status).toBe("passed");
    expect(clearanceCheck?.message).toContain("Cooler height fits: 165mm cooler / 185mm case clearance.");
    expect(result.valid).toBe(true);
  });
  it("does not pass GPU clearance when title length contradicts registry record", () => {
    const gpuWithConflict = makeResolved("gpu-test", "gpu", {
      brand: "Vendor",
      model: "GPU 300mm",
      length_mm: 300,
      aliases: ["GPU 300mm"],
      spec_conflict: "GPU listing states card length 340mm but the registry record gpu-test states 300mm; the dimension is unverified."
    });
    const midCase = makeResolved("case-320", "case", {
      brand: "Vendor",
      model: "Case 320mm",
      max_gpu_length_mm: 320,
      form_factors: ["ATX"],
      aliases: ["Case 320mm"]
    });

    const result = run({ gpu: gpuWithConflict, case: midCase });
    const gpuCheck = result.checks.find(
      (c) => c.rule === "clearance" && c.components.includes(gpuWithConflict.key)
    );
    expect(gpuCheck?.status).toBe("unverified");
    expect(gpuCheck?.status).not.toBe("passed");
    expect(gpuCheck?.message).toContain("conflicting length specs");
  });
});
