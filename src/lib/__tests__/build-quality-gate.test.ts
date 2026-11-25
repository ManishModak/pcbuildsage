import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { makeResolved, validateBuild } from "../rules-engine";
import { addPriceFigures, createValidateBuildTool } from "../tools/validate-build";
import { toModelValidateOutput } from "../tools/validate-build-model-view";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import { base, run } from "./rules-helpers";

function createCatalogDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function insertProduct(
  db: Database.Database,
  row: {
    id: string;
    name: string;
    category: string;
    price: number;
    currency?: string;
    country_code?: string;
    registry_key?: string | null;
    specs?: Record<string, unknown> | null;
  }
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (@id, @name, @normalized_name, @registry_key, @price, @currency, @country_code, 'Shop', @url, NULL, 1, @category, NULL, @specs, @now, @now)`
  ).run({
    id: row.id,
    name: row.name,
    normalized_name: row.name.toLowerCase(),
    registry_key: row.registry_key ?? null,
    price: row.price,
    currency: row.currency ?? "INR",
    country_code: row.country_code ?? "IN",
    url: `https://example.com/${row.id}`,
    category: row.category,
    specs: row.specs ? JSON.stringify(row.specs) : null,
    now
  });
}

const scope = { countryCode: "IN", currency: "INR" };
const ctx = { toolCallId: "quality-test", messages: [] } as never;

describe("Getting found 4: part-quality floor and build quality gate", () => {
  describe("1. PSU quality floor", () => {
    it("blocks a ₹650 unbranded/generic PSU with no 80 Plus certification or known brand", () => {
      const genericPsu = makeResolved("psu-generic-650inr", "psu", {
        brand: "Generic",
        model: "Generic 450W SMPS",
        aliases: ["Generic 450W SMPS"],
        wattage: 450,
        form_factor: "ATX"
      });
      const result = validateBuild(
        { cpu: base.cpu.key, gpu: base.gpu.key, psu: genericPsu.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === base.gpu.key ? base.gpu : part === genericPsu.key ? genericPsu : undefined),
          currency: "INR",
          componentMeta: { psu: { price: 650, currency: "INR", name: "Generic 450W SMPS Power Supply" } }
        }
      );
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "quality" }));
    });

    it("blocks a sub-₹2,000 unrated PSU without 80 Plus certification or reputable brand", () => {
      const cheapPsu = makeResolved("psu-local-1650", "psu", {
        brand: "Zebronics",
        model: "Zebronics N450S 450W Power Supply",
        aliases: ["Zebronics N450S"],
        wattage: 450,
        form_factor: "ATX"
      });
      const result = validateBuild(
        { cpu: base.cpu.key, psu: cheapPsu.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === cheapPsu.key ? cheapPsu : undefined),
          currency: "INR",
          componentMeta: { psu: { price: 1650, currency: "INR", name: "Zebronics N450S 450W Power Supply" } }
        }
      );
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "quality" }));
    });

    it.each([
      ["DeepCool PK450D 450W 80+ Bronze", "DeepCool", "80+ Bronze", 2650],
      ["DeepCool PK550D 550W 80+ Bronze", "DeepCool", "80+ Bronze", 3350],
      ["MSI MAG A550BN 550W 80 Plus Bronze", "MSI", "80+ Bronze", 3600],
      ["MSI MAG A650BN 650W 80+ Bronze", "MSI", "80+ Bronze", 4300],
      ["Corsair CX550 550W 80+ Bronze", "Corsair", "80+ Bronze", 4200],
      ["Corsair CV550 550W 80+ Bronze", "Corsair", "80+ Bronze", 3900],
      ["Cooler Master MWE 450 V2 80+ Bronze", "Cooler Master", "80+ Bronze", 3100],
      ["Antec Atom B550 550W 80+ Bronze", "Antec", "80+ Bronze", 3100],
      ["Gigabyte P550B 550W 80+ Bronze", "Gigabyte", "80+ Bronze", 3400],
      ["Seasonic Focus GX-550 80+ Gold", "Seasonic", "80+ Gold", 7500],
      ["Super Flower Leadex III 650W 80+ Gold", "Super Flower", "80+ Gold", 7900],
      ["EVGA 500 W1 500W 80+", "EVGA", "80+", 3200],
      ["Thermaltake Smart 500W 80+", "Thermaltake", "80+", 3100],
      ["NZXT C650 650W 80+ Bronze", "NZXT", "80+ Bronze", 4800],
      ["be quiet! System Power 10 550W 80+ Bronze", "be quiet!", "80+ Bronze", 4600],
      ["SilverStone Strider 500W 80+ White", "SilverStone", "80+", 3400],
      ["ASUS TUF Gaming 550B 80+ Bronze", "ASUS", "80+ Bronze", 4900],
      ["Lian Li SP750 750W 80+ Gold", "Lian Li", "80+ Gold", 9500],
      ["FSP HV PRO 550W 80+ Bronze", "FSP", "80+ Bronze", 3300],
      ["Montech AP550 550W 80+ White", "Montech", "80+", 3200],
      ["XPG Pylon 550W 80+ Bronze", "XPG", "80+ Bronze", 3500]
    ])("allows legitimate budget 80+ PSUs from real brands: %s", (model, brand, efficiency, price) => {
      const psu = makeResolved("psu-legit", "psu", {
        brand,
        model,
        aliases: [model],
        wattage: 550,
        efficiency,
        form_factor: "ATX"
      });
      const result = validateBuild(
        { cpu: base.cpu.key, psu: psu.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === psu.key ? psu : undefined),
          currency: "INR",
          componentMeta: { psu: { price, currency: "INR", name: model } }
        }
      );
      expect(result.valid).toBe(true);
      expect(result.issues.filter((i) => i.rule === "quality")).toEqual([]);
    });

    it("flags a bare-budget ₹2,250 PSU when userText asks for a quiet or silent build", () => {
      const budgetPsu = makeResolved("psu-2250", "psu", {
        brand: "DeepCool",
        model: "DeepCool PF450 450W 80+",
        aliases: ["PF450"],
        wattage: 450,
        efficiency: "80+",
        form_factor: "ATX"
      });
      const quietResult = validateBuild(
        { cpu: base.cpu.key, psu: budgetPsu.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === budgetPsu.key ? budgetPsu : undefined),
          userText: "Build me a quiet office and coding PC under ₹40,000",
          currency: "INR",
          componentMeta: { psu: { price: 2250, currency: "INR", name: "DeepCool PF450 450W 80 Plus Power Supply" } }
        }
      );
      expect(quietResult.issues).toContainEqual(
        expect.objectContaining({ severity: "advisory", rule: "quality", detail: expect.stringMatching(/quiet/i) })
      );

      // Non-quiet build with the same ₹2,250 real-brand 80+ PSU does NOT emit the quiet advisory.
      const normalResult = validateBuild(
        { cpu: base.cpu.key, psu: budgetPsu.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === budgetPsu.key ? budgetPsu : undefined),
          userText: "Basic office PC under ₹40,000",
          currency: "INR",
          componentMeta: { psu: { price: 2250, currency: "INR", name: "DeepCool PF450 450W 80 Plus Power Supply" } }
        }
      );
      expect(normalResult.issues.filter((i) => i.rule === "quality")).toEqual([]);
    });
  });

  describe("2. No fanless case under a gaming GPU", () => {
    it("blocks a case with registry included_fans === 0 under a gaming GPU", () => {
      const fanlessCase = makeResolved("case-0-fans", "case", {
        ...base.case.spec,
        model: "Budget Box",
        included_fans: 0
      });
      const result = run({ case: fanlessCase });
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ severity: "blocking", rule: "quality", detail: expect.stringMatching(/zero included fans/i) })
      );
    });

    it.each([
      "Ant Esports ICE-100TG (No Fan)",
      "Generic ATX Cabinet Without Fan",
      "Zebronics Chassis 0 Fan Black",
      "Case (Fans Not Included)"
    ])("blocks a fanless case inferred from product title '%s' under a gaming GPU", (model) => {
      const fanlessCase = makeResolved("case-title-fanless", "case", {
        ...base.case.spec,
        included_fans: undefined,
        model,
        aliases: [model]
      });
      const result = run({ case: fanlessCase });
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "quality" }));
    });

    it("does not block a case with fans or a display-only low-TDP adapter", () => {
      const fanHubCase = makeResolved("case-no-hub", "case", {
        ...base.case.spec,
        model: "Mesh Case (No Fan Hub)"
      });
      expect(run({ case: fanHubCase }).valid).toBe(true);

      const fanlessCase = makeResolved("case-0-fans", "case", { ...base.case.spec, included_fans: 0 });
      const displayGpu = makeResolved("gt-710", "gpu", {
        brand: "NVIDIA",
        model: "GeForce GT 710",
        aliases: ["GT 710"],
        tdp_w: 19,
        length_mm: 150,
        segment: "display"
      });
      const result = run({ case: fanlessCase, gpu: displayGpu });
      expect(result.valid).toBe(true);
    });
  });

  describe('3. "Compact" means small form factor', () => {
    it("flags an ATX mid-tower case when userText asks for a compact / SFF / mini PC", () => {
      const atxCase = makeResolved("corsair-4000d", "case", {
        ...base.case.spec,
        model: "Corsair 4000D AIRFLOW Mid Tower",
        form_factors: ["E-ATX", "ATX", "Micro-ATX", "Mini-ITX"]
      });
      const matxBoard = makeResolved("mobo-matx", "motherboard", {
        ...base.motherboard.spec,
        form_factor: "Micro-ATX"
      });
      for (const userText of [
        "Build me a compact gaming PC under ₹80,000",
        "Need an SFF workstation",
        "Looking for a small PC for my desk"
      ]) {
        const result = validateBuild(
          { cpu: base.cpu.key, motherboard: matxBoard.key, case: atxCase.key },
          {
            resolve: (part) => (part === base.cpu.key ? base.cpu : part === matxBoard.key ? matxBoard : part === atxCase.key ? atxCase : undefined),
            userText
          }
        );
        expect(result.valid, userText).toBe(false);
        expect(result.issues).toContainEqual(
          expect.objectContaining({ severity: "blocking", rule: "quality", detail: expect.stringMatching(/compact\/SFF|Mini-ITX/i) })
        );
      }
    });

    it("passes Mini-ITX and compact Micro-ATX cases for compact builds, and ignores 'small budget'", () => {
      const matxCase = makeResolved("cm-q300l", "case", {
        ...base.case.spec,
        model: "Cooler Master MasterBox Q300L",
        form_factors: ["Micro-ATX", "Mini-ITX"]
      });
      const matxBoard = makeResolved("mobo-matx", "motherboard", {
        ...base.motherboard.spec,
        form_factor: "Micro-ATX"
      });
      const compactOk = validateBuild(
        { cpu: base.cpu.key, motherboard: matxBoard.key, case: matxCase.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === matxBoard.key ? matxBoard : part === matxCase.key ? matxCase : undefined),
          userText: "Compact PC under ₹60,000"
        }
      );
      expect(compactOk.valid).toBe(true);

      const smallBudget = validateBuild(
        { cpu: base.cpu.key, motherboard: base.motherboard.key, case: base.case.key },
        {
          resolve: (part) => (part === base.cpu.key ? base.cpu : part === base.motherboard.key ? base.motherboard : part === base.case.key ? base.case : undefined),
          userText: "Gaming PC on a small budget of ₹40,000"
        }
      );
      expect(smallBudget.valid).toBe(true);
    });
  });

  describe("4. Boxed CPU stock cooler honesty & redundancy", () => {
    it("rejects { name: 'Stock Cooler', included: true } as blocking when CPU includes_cooler === false", () => {
      const cpuNoCooler = makeResolved("cpu-7600x", "cpu", {
        brand: "AMD",
        model: "AMD Ryzen 5 7600X",
        aliases: ["Ryzen 5 7600X"],
        socket: "AM5",
        tdp_w: 105,
        includes_cooler: false
      });
      const result = validateBuild(
        { cpu: cpuNoCooler.key, cooler: { name: "Stock Cooler", included: true } },
        { resolve: (part) => (part === cpuNoCooler.key ? cpuNoCooler : undefined) }
      );
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ severity: "blocking", rule: "cooler", detail: expect.stringMatching(/does not include a stock cooler/i) })
      );
    });

    it("surfaces an actionable advisory when a separate paid cooler is added to a boxed CPU that includes a stock cooler", () => {
      const cpuBoxed = makeResolved("cpu-7600", "cpu", {
        brand: "AMD",
        model: "AMD Ryzen 5 7600",
        aliases: ["Ryzen 5 7600"],
        socket: "AM5",
        tdp_w: 65,
        includes_cooler: true,
        cooler_name: "AMD Wraith Stealth"
      });
      const paidCooler = makeResolved("ag400", "cooler", {
        brand: "DeepCool",
        model: "DeepCool AG400",
        aliases: ["AG400"],
        cooler_type: "air",
        height_mm: 150,
        sockets: ["AM5", "AM4"],
        tdp_rating_w: 220
      });

      const budgetBuild = validateBuild(
        { cpu: cpuBoxed.key, cooler: paidCooler.key },
        {
          resolve: (part) => (part === cpuBoxed.key ? cpuBoxed : part === paidCooler.key ? paidCooler : undefined),
          userText: "Gaming PC under ₹60,000",
          currency: "INR",
          componentMeta: { cooler: { price: 1850, currency: "INR", name: "DeepCool AG400" } }
        }
      );
      expect(budgetBuild.valid).toBe(true);
      expect(budgetBuild.issues).toContainEqual(
        expect.objectContaining({
          severity: "advisory",
          rule: "cooler",
          detail: expect.stringMatching(/already includes a stock cooler/i)
        })
      );

      // Quiet build suppresses the redundant-cooler advisory.
      const quietBuild = validateBuild(
        { cpu: cpuBoxed.key, cooler: paidCooler.key },
        {
          resolve: (part) => (part === cpuBoxed.key ? cpuBoxed : part === paidCooler.key ? paidCooler : undefined),
          userText: "Quiet gaming PC under ₹60,000",
          currency: "INR",
          componentMeta: { cooler: { price: 1850, currency: "INR", name: "DeepCool AG400" } }
        }
      );
      expect(quietBuild.issues.filter((i) => i.rule === "cooler" && i.severity === "advisory")).toEqual([]);
    });
  });

  describe('5. "Recommended" label honesty', () => {
    const snap = (total: number) => ({ snapshot: { total, currency: "INR" } as BuildSnapshot });

    it("warns when a 'Recommended' build is over budget (>3%) alongside an in-budget build", () => {
      const results: Record<string, ReturnType<typeof snap> & { price_summary?: string; label_note?: string }> = {
        "Within budget": snap(49000),
        "Recommended": snap(53000) // +6% over 50k while Within budget exists
      };
      addPriceFigures(results, 50000);
      expect(results["Recommended"].price_summary).toMatch(/do not label an over-budget build 'Recommended'/i);
      expect(results["Recommended"].label_note).toMatch(/do not label an over-budget build 'Recommended'/i);
    });

    it("warns when a 'Recommended' build is far over budget (>5%) even without an in-budget option", () => {
      const results: Record<string, ReturnType<typeof snap> & { price_summary?: string; label_note?: string }> = {
        "Recommended build": snap(55000) // +10% over 50k
      };
      addPriceFigures(results, 50000);
      expect(results["Recommended build"].price_summary).toMatch(/10%.*over budget/i);
      expect(results["Recommended build"].label_note).toMatch(/10%.*over budget/i);
    });

    it("allows a small <=3% clear value-jump build labelled 'Recommended'", () => {
      const results: Record<string, ReturnType<typeof snap> & { price_summary?: string; label_note?: string }> = {
        "Within budget": snap(45000),
        "Recommended": snap(46000) // +2.2% over 45k
      };
      addPriceFigures(results, 45000);
      expect(results["Recommended"].label_note).toBeUndefined();
      expect(results["Recommended"].price_summary).toBe("Total ₹46,000; ₹1,000 over the ₹45,000 budget; ₹1,000 more than 'Within budget'");
    });
  });

  describe("validate_build integration with catalog DB and model view", () => {
    let db: Database.Database;
    let repo: SqliteCatalogRepository;

    beforeEach(() => {
      db = createCatalogDb();
      insertProduct(db, { id: "cpu-5600-001", name: "AMD Ryzen 5 5600 Processor", category: "cpu", registry_key: "amd-ryzen-5-5600", price: 11500 });
      insertProduct(db, { id: "cpu-7600x-01", name: "AMD Ryzen 5 7600X Processor", category: "cpu", registry_key: "amd-ryzen-5-7600x", price: 19500, specs: { includes_cooler: false } });
      insertProduct(db, { id: "mobo-b550-01", name: "MSI B550M-A Pro Micro ATX Motherboard", category: "motherboard", price: 6200 });
      insertProduct(db, { id: "gpu-5060-01", name: "MSI RTX 5060 8GB Graphics Card", category: "gpu", registry_key: "nvidia-rtx-5060", price: 29500 });
      insertProduct(db, { id: "ram-16gb-01", name: "Corsair 16GB (2x8GB) DDR4 3200MHz", category: "ram", price: 3800 });
      insertProduct(db, { id: "ssd-1tb-001", name: "WD Blue 1TB M.2 NVMe SSD", category: "storage", price: 5200 });
      insertProduct(db, { id: "psu-junk-650", name: "Generic 500W SMPS Power Supply", category: "psu", price: 650 });
      insertProduct(db, { id: "psu-pf450-2250", name: "DeepCool PF450 450W 80 Plus Power Supply", category: "psu", price: 2250 });
      insertProduct(db, { id: "psu-good-550", name: "Corsair CX550 550W 80+ Bronze PSU", category: "psu", registry_key: "corsair-cx550", price: 4100 });
      insertProduct(db, { id: "case-nofan-1", name: "Zebronics Cabinet (No Fan)", category: "case", price: 1600, specs: { included_fans: 0, form_factors: ["ATX", "Micro-ATX"], max_gpu_length_mm: 320, max_cooler_height_mm: 160 } });
      insertProduct(db, { id: "case-atx-mid", name: "Corsair 4000D Airflow ATX Mid Tower", category: "case", registry_key: "corsair-4000d-airflow", price: 7200 });
      insertProduct(db, { id: "cooler-ag400", name: "DeepCool AG400 Air Cooler", category: "cooler", registry_key: "deepcool-ag400", price: 1850 });
      repo = new SqliteCatalogRepository(db);
    });

    afterEach(async () => {
      await repo.close();
    });

    it("surfaces PSU floor, fanless case, compact case, fake stock cooler, redundant cooler, and Recommended label in validate_build + model view", async () => {
      const tool = createValidateBuildTool(scope, repo, undefined, {
        userText: "Build me a quiet compact gaming PC under ₹50,000"
      });
      const out = await tool.execute!(
        {
          budget: 50000,
          builds: [
            {
              label: "Within budget",
              parts: {
                cpu: { product_id: "cpu-5600-001" },
                motherboard: { product_id: "mobo-b550-01" },
                gpu: { product_id: "gpu-5060-01" },
                ram: { product_id: "ram-16gb-01" },
                storage: { product_id: "ssd-1tb-001" },
                psu: { product_id: "psu-junk-650" },
                case: { product_id: "case-nofan-1" }
              }
            },
            {
              label: "Recommended",
              parts: {
                cpu: { product_id: "cpu-5600-001" },
                motherboard: { product_id: "mobo-b550-01" },
                gpu: { product_id: "gpu-5060-01" },
                ram: { product_id: "ram-16gb-01" },
                storage: { product_id: "ssd-1tb-001" },
                psu: { product_id: "psu-pf450-2250" },
                case: { product_id: "case-atx-mid" }
              }
            },
            {
              label: "Fake stock",
              parts: {
                cpu: { product_id: "cpu-7600x-01" },
                motherboard: { product_id: "mobo-b550-01" },
                gpu: { product_id: "gpu-5060-01" },
                ram: { product_id: "ram-16gb-01" },
                storage: { product_id: "ssd-1tb-001" },
                psu: { product_id: "psu-pf450-2250" },
                case: { product_id: "case-atx-mid" },
                cooler: { name: "Stock Cooler", included: true } as never
              }
            }
          ]
        },
        ctx
      );

      const view = toModelValidateOutput(out) as { builds: Record<string, Record<string, unknown>> };
      const b1 = view.builds["Within budget"];
      expect(b1.valid).toBe(false);
      expect(String(b1.quality_note)).toMatch(/PSU quality floor/i);
      expect(String(b1.quality_note)).toMatch(/zero included fans/i);

      const b2 = view.builds["Recommended"];
      expect(b2.valid).toBe(false);
      expect(String(b2.quality_note)).toMatch(/quiet/i);
      expect(String(b2.quality_note)).toMatch(/compact\/SFF/i);
      expect(String(b2.label_note)).toMatch(/over budget/i);

      const b3 = view.builds["Fake stock"];
      expect(b3.valid).toBe(false);
      expect(String(b3.quality_note)).toMatch(/does not include a stock cooler/i);
    });

    it("surfaces redundant paid cooler advisory in validate_build for non-quiet boxed CPU", async () => {
      const tool = createValidateBuildTool(scope, repo, undefined, {
        userText: "Build me a gaming PC under ₹65,000"
      });
      const out = await tool.execute!(
        {
          budget: 65000,
          builds: [
            {
              label: "Within budget",
              parts: {
                cpu: { product_id: "cpu-5600-001" },
                motherboard: { product_id: "mobo-b550-01" },
                gpu: { product_id: "gpu-5060-01" },
                ram: { product_id: "ram-16gb-01" },
                storage: { product_id: "ssd-1tb-001" },
                psu: { product_id: "psu-good-550" },
                case: { product_id: "case-atx-mid" },
                cooler: { product_id: "cooler-ag400" }
              }
            }
          ]
        },
        ctx
      );
      const view = toModelValidateOutput(out) as { builds: Record<string, Record<string, unknown>> };
      expect(view.builds["Within budget"].valid).toBe(true);
      expect(String(view.builds["Within budget"].quality_note)).toMatch(/already includes a stock cooler/i);
    });

    it("S1/S10/S11: blocks claimed stock cooler, missing cooler on no-cooler CPU, offer-level spec overrides, and owned stock cooler spoofing through inputSchema -> execute", async () => {
      insertProduct(db, {
        id: "cpu-5600-tray",
        name: "AMD Ryzen 5 5600 Processor",
        category: "cpu",
        registry_key: "amd-ryzen-5-5600",
        price: 10500,
        specs: { includes_cooler: false }
      });
      insertProduct(db, {
        id: "case-a3-matx",
        name: "Lian Li DAN Cases A3-mATX Mini Tower",
        category: "case",
        registry_key: "lian-li-a3-matx",
        price: 6800
      });
      insertProduct(db, {
        id: "case-spaced-0",
        name: "Budget Mesh Cabinet",
        category: "case",
        registry_key: "corsair-4000d-airflow",
        price: 4000,
        specs: { included_fans: " 0 " }
      });

      const tool = createValidateBuildTool(scope, repo, undefined, {
        requireCatalogParts: true,
        userText: "Build me a gaming PC under ₹80,000"
      });
      const validate = (tool.inputSchema as unknown as { validate: (input: unknown) => Promise<{ success: boolean; value?: unknown }> }).validate;

      // S1: { name: "Stock Cooler", included: true } must survive normalizeParts + partSchema and fail validation on includes_cooler: false CPU
      const rawClaimed = {
        budget: 80000,
        builds: [
          {
            label: "Claimed stock",
            parts: {
              cpu: { product_id: "cpu-5600-tray" },
              motherboard: { product_id: "mobo-b550-01" },
              gpu: { product_id: "gpu-5060-01" },
              ram: { product_id: "ram-16gb-01" },
              storage: { product_id: "ssd-1tb-001" },
              psu: { product_id: "psu-good-550" },
              case: { product_id: "case-atx-mid" },
              cooler: { name: "Stock Cooler", included: true }
            }
          },
          {
            label: "Omitted cooler",
            parts: {
              cpu: { product_id: "cpu-5600-tray" },
              motherboard: { product_id: "mobo-b550-01" },
              gpu: { product_id: "gpu-5060-01" },
              ram: { product_id: "ram-16gb-01" },
              storage: { product_id: "ssd-1tb-001" },
              psu: { product_id: "psu-good-550" },
              case: { product_id: "case-atx-mid" }
            }
          },
          {
            label: "Owned stock bypass",
            parts: {
              cpu: { product_id: "cpu-5600-tray" },
              motherboard: { product_id: "mobo-b550-01" },
              gpu: { product_id: "gpu-5060-01" },
              ram: { product_id: "ram-16gb-01" },
              storage: { product_id: "ssd-1tb-001" },
              psu: { product_id: "psu-good-550" },
              case: { product_id: "case-a3-matx" },
              cooler: { name: "AMD Wraith Stealth", owned: true }
            }
          },
          {
            label: "Spaced zero fans",
            parts: {
              cpu: { product_id: "cpu-5600-001" },
              motherboard: { product_id: "mobo-b550-01" },
              gpu: { product_id: "gpu-5060-01" },
              ram: { product_id: "ram-16gb-01" },
              storage: { product_id: "ssd-1tb-001" },
              psu: { product_id: "psu-good-550" },
              case: { product_id: "case-spaced-0" }
            }
          }
        ]
      };

      const parsed = await validate(rawClaimed);
      expect(parsed.success).toBe(true);
      const out = (await tool.execute!(parsed.value as never, ctx)) as {
        builds: Record<string, {
          valid: boolean;
          missing_parts?: string[];
          unnamed_owned?: Array<{ category: string; name: string }>;
          snapshot: BuildSnapshot;
          issues: Array<{ rule: string; severity: string; detail: string }>;
        }>;
      };

      // S1 + S10: offer-level includes_cooler: false survived registry match and blocked claimed stock cooler
      expect(out.builds["Claimed stock"].valid).toBe(false);
      expect(out.builds["Claimed stock"].issues).toContainEqual(
        expect.objectContaining({ severity: "blocking", rule: "cooler" })
      );
      expect(out.builds["Claimed stock"].snapshot.components.find((c) => c.category === "cooler")?.included).toBe(false);

      // S1: omitting cooler on complete no-cooler CPU build blocks + reports missing_parts: ["cooler"]
      expect(out.builds["Omitted cooler"].valid).toBe(false);
      expect(out.builds["Omitted cooler"].missing_parts).toContain("cooler");

      // S11 + S3: owned Wraith Stealth stays owned: true (not included: true) and triggers unnamed_owned; Lian Li A3-mATX is blocked as fanless
      const ownedCoolerComp = out.builds["Owned stock bypass"].snapshot.components.find((c) => c.category === "cooler");
      expect(ownedCoolerComp?.owned).toBe(true);
      expect(ownedCoolerComp?.included).toBe(false);
      expect(out.builds["Owned stock bypass"].unnamed_owned).toContain('cooler "AMD Wraith Stealth"');
      expect(out.builds["Owned stock bypass"].valid).toBe(false);
      expect(out.builds["Owned stock bypass"].issues).toContainEqual(
        expect.objectContaining({ severity: "blocking", rule: "quality", detail: expect.stringMatching(/zero included fans/i) })
      );

      // S10: offer-level included_fans: " 0 " survived registry match and blocked
      expect(out.builds["Spaced zero fans"].valid).toBe(false);
      expect(out.builds["Spaced zero fans"].issues).toContainEqual(
        expect.objectContaining({ severity: "blocking", rule: "quality", detail: expect.stringMatching(/zero included fans/i) })
      );
    });
  });

  describe("Regression checks for PSU spoofing, unknown fans, negated intent, sole Recommended, and boxed 5600F (S2-S6)", () => {
    it("S2: parses 80+ Bronze from titles, blocks compatibility-spoofed generic PSUs & cheap EUR/GBP PSUs, and ignores marketing 'Quiet' in PSU titles", () => {
      const spoofed = makeResolved("psu-spoof", "psu", {
        brand: "Generic",
        model: "Generic 550W Corsair-compatible SMPS",
        aliases: ["Generic 550W Corsair-compatible SMPS"],
        wattage: 550,
        form_factor: "ATX"
      });
      const spoofRes = validateBuild(
        { cpu: base.cpu.key, psu: spoofed.key },
        {
          resolve: (p) => (p === base.cpu.key ? base.cpu : p === spoofed.key ? spoofed : undefined),
          currency: "INR",
          componentMeta: { psu: { price: 650, currency: "INR", name: "Generic 550W Corsair-compatible SMPS" } }
        }
      );
      expect(spoofRes.valid).toBe(false);

      // Cheap GBP/EUR generic PSU is blocked
      const gbpCheap = makeResolved("psu-gbp", "psu", {
        brand: "Unknown",
        model: "Value 500W PSU",
        aliases: ["Value 500W PSU"],
        wattage: 500,
        form_factor: "ATX"
      });
      for (const currency of ["GBP", "EUR"] as const) {
        const res = validateBuild(
          { cpu: base.cpu.key, psu: gbpCheap.key },
          {
            resolve: (p) => (p === base.cpu.key ? base.cpu : p === gbpCheap.key ? gbpCheap : undefined),
            currency,
            componentMeta: { psu: { price: 10, currency, name: "Value 500W PSU" } }
          }
        );
        expect(res.valid, currency).toBe(false);
      }

      // 80+ Bronze in title (without efficiency field) passes ₹1,900 floor
      const title80Plus = makeResolved("psu-80plus-title", "psu", {
        brand: "Circle",
        model: "Circle 500W 80+ Bronze PSU",
        aliases: ["Circle 500W 80+ Bronze PSU"],
        wattage: 500,
        form_factor: "ATX"
      });
      const title80Res = validateBuild(
        { cpu: base.cpu.key, psu: title80Plus.key },
        {
          resolve: (p) => (p === base.cpu.key ? base.cpu : p === title80Plus.key ? title80Plus : undefined),
          currency: "INR",
          componentMeta: { psu: { price: 1900, currency: "INR", name: "Circle 500W 80+ Bronze PSU" } }
        }
      );
      expect(title80Res.valid).toBe(true);

      // Bare "Ultra Quiet Fan" marketing word does NOT suppress quiet-build PSU advisory
      const noisyMarketing = makeResolved("psu-pf450-q", "psu", {
        brand: "DeepCool",
        model: "DeepCool PF450 450W Ultra Quiet Fan",
        aliases: ["PF450"],
        wattage: 450,
        efficiency: "80+",
        form_factor: "ATX"
      });
      const quietRes = validateBuild(
        { cpu: base.cpu.key, psu: noisyMarketing.key },
        {
          resolve: (p) => (p === base.cpu.key ? base.cpu : p === noisyMarketing.key ? noisyMarketing : undefined),
          userText: "Quiet PC under ₹40,000",
          currency: "INR",
          componentMeta: { psu: { price: 2250, currency: "INR", name: "DeepCool PF450 450W Ultra Quiet Fan" } }
        }
      );
      expect(quietRes.issues).toContainEqual(
        expect.objectContaining({ severity: "advisory", rule: "quality", detail: expect.stringMatching(/quiet/i) })
      );
    });

    it("S3: records unknown case fan count as unverified rather than passed", () => {
      const unknownFansCase = makeResolved("case-unknown-fans", "case", {
        brand: "Fractal Design",
        model: "Mystery Box Case",
        aliases: ["Mystery Box Case"],
        max_gpu_length_mm: 350,
        max_cooler_height_mm: 170,
        form_factors: ["ATX", "Micro-ATX"],
        supported_psu_form_factors: ["ATX"]
      });
      const result = run({ case: unknownFansCase });
      expect(result.valid).toBe(true);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ rule: "quality", status: "unverified", message: expect.stringMatching(/does not specify included fan count/i) })
      );
    });

    it("S4: respects negated clauses in compact and quiet user intent", () => {
      const atxCase = makeResolved("corsair-4000d", "case", {
        ...base.case.spec,
        model: "Corsair 4000D AIRFLOW Mid Tower",
        form_factors: ["E-ATX", "ATX", "Micro-ATX", "Mini-ITX"]
      });
      const matxBoard = makeResolved("mobo-matx", "motherboard", {
        ...base.motherboard.spec,
        form_factor: "Micro-ATX"
      });
      const budgetPsu = makeResolved("psu-2250", "psu", {
        brand: "DeepCool",
        model: "DeepCool PF450 450W 80+",
        aliases: ["PF450"],
        wattage: 450,
        efficiency: "80+",
        form_factor: "ATX"
      });

      // "compact build, no mid-tower" must still block mid-tower!
      const noMidTower = validateBuild(
        { cpu: base.cpu.key, motherboard: matxBoard.key, case: atxCase.key },
        {
          resolve: (p) => (p === base.cpu.key ? base.cpu : p === matxBoard.key ? matxBoard : p === atxCase.key ? atxCase : undefined),
          userText: "I want a compact build, no mid-tower"
        }
      );
      expect(noMidTower.valid).toBe(false);

      // "I do not need a compact build" must NOT block ATX mid-tower
      const notCompact = validateBuild(
        { cpu: base.cpu.key, motherboard: matxBoard.key, case: atxCase.key },
        {
          resolve: (p) => (p === base.cpu.key ? base.cpu : p === matxBoard.key ? matxBoard : p === atxCase.key ? atxCase : undefined),
          userText: "I do not need a compact build"
        }
      );
      expect(notCompact.valid).toBe(true);

      // "I do not need a quiet build" must NOT emit quiet PSU warning
      const notQuiet = validateBuild(
        { cpu: base.cpu.key, psu: budgetPsu.key },
        {
          resolve: (p) => (p === base.cpu.key ? base.cpu : p === budgetPsu.key ? budgetPsu : undefined),
          userText: "I do not need a quiet build",
          currency: "INR",
          componentMeta: { psu: { price: 2250, currency: "INR", name: "DeepCool PF450 450W 80+" } }
        }
      );
      expect(notQuiet.issues.filter((i) => i.rule === "quality")).toEqual([]);
    });

    it("S5: flags a sole 'Recommended' build that is >3% (e.g. 4%) over budget", () => {
      const results: Record<string, { snapshot: BuildSnapshot; price_summary?: string; label_note?: string }> = {
        Recommended: { snapshot: { total: 10400, currency: "INR" } as BuildSnapshot }
      };
      addPriceFigures(results, 10000);
      expect(results["Recommended"].label_note).toMatch(/4%.*over budget/i);
      expect(results["Recommended"].price_summary).toMatch(/4%.*over budget/i);
    });

    it("S6: detects boxed Ryzen 5 5600F stock cooler and lets Tray offer title override boxed default", () => {
      const cpu5600f = makeResolved("cpu-5600f", "cpu", {
        brand: "AMD",
        model: "AMD Ryzen 5 5600F",
        aliases: ["Ryzen 5 5600F"],
        socket: "AM4",
        tdp_w: 65
      });
      const paidCooler = makeResolved("ag400", "cooler", {
        brand: "DeepCool",
        model: "DeepCool AG400",
        aliases: ["AG400"],
        cooler_type: "air",
        height_mm: 150,
        sockets: ["AM4"],
        tdp_rating_w: 220
      });
      const boxedRes = validateBuild(
        { cpu: cpu5600f.key, cooler: paidCooler.key },
        {
          resolve: (p) => (p === cpu5600f.key ? cpu5600f : p === paidCooler.key ? paidCooler : undefined),
          userText: "Gaming PC under ₹60,000",
          currency: "INR",
          componentMeta: {
            cpu: { name: "AMD Ryzen 5 5600F Desktop Processor 100-000001903BOX" },
            cooler: { price: 1850, currency: "INR", name: "DeepCool AG400" }
          }
        }
      );
      expect(boxedRes.issues).toContainEqual(
        expect.objectContaining({ severity: "advisory", rule: "cooler", detail: expect.stringMatching(/already includes a stock cooler/i) })
      );

      // Tray offer title overrides boxed registry default -> no redundant cooler advisory
      const trayRes = validateBuild(
        { cpu: cpu5600f.key, cooler: paidCooler.key },
        {
          resolve: (p) => (p === cpu5600f.key ? cpu5600f : p === paidCooler.key ? paidCooler : undefined),
          userText: "Gaming PC under ₹60,000",
          currency: "INR",
          componentMeta: {
            cpu: { name: "AMD Ryzen 5 5600F Tray Processor Without Fan" },
            cooler: { price: 1850, currency: "INR", name: "DeepCool AG400" }
          }
        }
      );
      expect(trayRes.issues.filter((i) => i.rule === "cooler" && i.severity === "advisory")).toEqual([]);
    });
  });
});
