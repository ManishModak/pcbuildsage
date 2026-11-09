import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { createValidateBuildTool, wantsGamingGpu } from "../validate-build";
import { toModelValidateOutput } from "../validate-build-model-view";
import { createPresentBuildTool, toModelPresentOutput } from "../present-build";
import { createTurnValidationStore } from "../turn-state";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function insert(db: Database.Database, row: Record<string, unknown>) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (@id, @name, @normalized_name, @registry_key, @price, @currency, @country_code, @retailer, @url, @image_url, @in_stock, @category, @subcategory, @specs, @first_seen, @last_scraped)`
  ).run({
    id: row.id,
    name: row.name,
    normalized_name: String(row.name).toLowerCase(),
    registry_key: row.registry_key ?? null,
    price: row.price,
    currency: "IN" === row.country_code ? "INR" : row.currency ?? "INR",
    country_code: row.country_code ?? "IN",
    retailer: row.retailer ?? "R",
    url: row.url ?? `https://example.com/${row.id}`,
    image_url: null,
    in_stock: 1,
    category: row.category,
    subcategory: null,
    specs: null,
    first_seen: now,
    last_scraped: now
  });
}

const FULL_CPU = "da6670a41d06377759be1c70e28f32230239c099";
const FULL_BOARD = "b2f9d25f2b06377759be1c70e28f32230239c200";
const scope = { countryCode: "IN", currency: "INR" };
const ctx = { toolCallId: "t", messages: [] } as never;

describe("present_build per-turn validation", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = createDb();
    insert(db, { id: FULL_CPU, name: "Intel Core i9-14900K Desktop Processor", category: "cpu", registry_key: "intel-core-i9-14900k", price: 55000, country_code: "IN" });
    insert(db, { id: FULL_BOARD, name: "ASUS ROG Strix Z790-E Gaming WiFi Motherboard", category: "motherboard", registry_key: "asus-rog-strix-z790-e", price: 45000, country_code: "IN" });
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("errors listing valid labels when label has no validation this turn", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    await validate.execute!(
      { builds: [{ label: "Within budget", parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD }, ram: { name: "16GB DDR5", owned: true }, storage: { name: "1TB NVMe SSD", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } } }] },
      ctx
    );
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Nope" }] }, ctx)) as {
      presented: boolean;
      error: string;
      valid_labels: string[];
    };
    expect(out.presented).toBe(false);
    expect(out.error).toContain("Within budget");
    expect(out.valid_labels).toEqual(["Within budget"]);
  });

  it("presents an unvalidated label whose product IDs are exactly one validated build, labelled honestly", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    const owned = { ram: { name: "16GB DDR5", owned: true }, storage: { name: "1TB NVMe SSD", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } };
    await validate.execute!({ budget: 90000, builds: [{ label: "Build 1", parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD }, ...owned } }] }, ctx);
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Within budget", product_ids: [FULL_CPU.slice(0, 10), FULL_BOARD.slice(0, 10)] }] }, ctx)) as {
      presented: boolean;
      builds: Array<{ label: string; validated_label?: string; product_ids: string[] }>;
    };
    expect(out.presented).toBe(true);
    expect(out.builds[0]).toMatchObject({ label: "Closest to budget (₹10,000 over)", validated_label: "Within budget", product_ids: [FULL_CPU, FULL_BOARD] });

    // Within the budget, the requested label stands with no relabel note.
    const roomy = createTurnValidationStore();
    await createValidateBuildTool(scope, repo, roomy).execute!({ budget: 150000, builds: [{ label: "Build 1", parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD }, ...owned } }] }, ctx);
    const fits = (await createPresentBuildTool(roomy).execute!({ builds: [{ label: "Within budget", product_ids: [FULL_CPU.slice(0, 10), FULL_BOARD.slice(0, 10)] }] }, ctx)) as {
      builds: Array<{ label: string; validated_label?: string }>;
      label_note?: string;
    };
    expect(fits.builds[0].label).toBe("Within budget");
    expect(fits.builds[0].validated_label).toBeUndefined();
    expect(fits.label_note).toBeUndefined();

    // IDs that are only part of the validated build still find nothing.
    const partial = (await present.execute!({ builds: [{ label: "Within budget", product_ids: [FULL_CPU.slice(0, 10)] }] }, ctx)) as { presented: boolean; error: string };
    expect(partial.presented).toBe(false);
    expect(partial.error).toContain("No validation this turn for label 'Within budget'");
  });

  it("presents product IDs validated in separate calls by validating them together first", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    const owned = { ram: { name: "16GB DDR5", owned: true }, storage: { name: "1TB NVMe SSD", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } };
    // The CPU alone under one label, the board under another (a model splitting one build across calls).
    await validate.execute!({ builds: [{ label: "Split", parts: { cpu: { product_id: FULL_CPU }, ...owned } }] }, ctx);
    await validate.execute!({ builds: [{ label: "Board", parts: { motherboard: { product_id: FULL_BOARD } } }] }, ctx);
    const revalidate = (label: string, parts: Record<string, unknown>) => Promise.resolve(validate.execute!({ builds: [{ label, parts }] } as never, ctx));
    const present = createPresentBuildTool(store, { revalidate });
    const out = (await present.execute!({ builds: [{ label: "Split", product_ids: [FULL_CPU.slice(0, 10), FULL_BOARD.slice(0, 10)] }] }, ctx)) as {
      presented: boolean;
      builds: Array<{ label: string; product_ids: string[] }>;
    };
    expect(out.presented).toBe(true);
    expect(out.builds[0].product_ids).toEqual(expect.arrayContaining([FULL_CPU, FULL_BOARD]));
    // The label's owned parts came along, so the revalidated build is whole.
    expect(store.get("split")?.snapshot.components.filter((c) => c.owned)).toHaveLength(4);

    // IDs that leave out a part the validated build has don't shrink it to those parts.
    const shrunk = (await present.execute!({ builds: [{ label: "Split", product_ids: [FULL_CPU.slice(0, 10)] }] }, ctx)) as { presented: boolean; error: string };
    expect(shrunk.presented).toBe(false);
    expect(shrunk.error).toContain("differ from its validation snapshot");
    expect(store.get("split")?.snapshot.components.map((c) => c.category)).toContain("motherboard");

    // An ID no validation this turn resolved is still refused.
    const unknown = (await present.execute!({ builds: [{ label: "Split", product_ids: [FULL_CPU.slice(0, 10), "ffffffffff"] }] }, ctx)) as { presented: boolean };
    expect(unknown.presented).toBe(false);
  });

  it("revalidates a split build only when the IDs keep every part, included cooler and drive it had", async () => {
    const SSD_A = "5a5a5a5a5a06377759be1c70e28f32230239c301";
    const SSD_B = "5b5b5b5b5b06377759be1c70e28f32230239c302";
    // An i5-12400 ships with the Laminar RM1 its 65 W fits.
    const CPU = "c4c4c4c4c406377759be1c70e28f32230239c303";
    insert(db, { id: CPU, name: "Intel Core i5-12400 Desktop Processor", category: "cpu", registry_key: "intel-core-i5-12400", price: 13000, country_code: "IN" });
    insert(db, { id: SSD_A, name: "Samsung 990 Pro 1TB NVMe SSD", category: "storage", price: 9000, country_code: "IN" });
    insert(db, { id: SSD_B, name: "Crucial MX500 2TB SATA SSD", category: "storage", price: 11000, country_code: "IN" });
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    const owned = { ram: { name: "16GB DDR5", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } };
    const split = { cpu: { product_id: CPU }, cooler: { key: "intel-laminar-rm1", name: "Stock cooler (included)" }, storage: [{ product_id: SSD_A }, { product_id: SSD_B }], ...owned };
    await validate.execute!({ builds: [{ label: "Split", parts: split }] }, ctx);
    await validate.execute!({ builds: [{ label: "Board", parts: { motherboard: { product_id: FULL_BOARD } } }] }, ctx);
    expect(store.get("split")?.snapshot.components.some((c) => c.category === "cooler" && c.included)).toBe(true);
    const revalidated: Array<Record<string, unknown>> = [];
    const revalidate = (label: string, parts: Record<string, unknown>) => {
      revalidated.push(parts);
      return Promise.resolve(validate.execute!({ builds: [{ label, parts }] } as never, ctx));
    };
    const present = createPresentBuildTool(store, { revalidate });
    const ids = (...full: string[]) => full.map((id) => id.slice(0, 10));

    // Leaving out one of two drives doesn't drop it.
    const fewer = (await present.execute!({ builds: [{ label: "Split", product_ids: ids(CPU, FULL_BOARD, SSD_A) }] }, ctx)) as { presented: boolean };
    expect(fewer.presented).toBe(false);
    expect(store.get("split")?.snapshot.components.filter((c) => c.category === "storage")).toHaveLength(2);

    // Every bought part plus the new board: the included cooler and both drives come along.
    const whole = (await present.execute!({ builds: [{ label: "Split", product_ids: ids(CPU, FULL_BOARD, SSD_A, SSD_B) }] }, ctx)) as { presented: boolean };
    expect(whole.presented).toBe(true);
    // The cooler goes back as first given, registry key included.
    expect(revalidated.at(-1)?.cooler).toEqual(split.cooler);
    const components = store.get("split")?.snapshot.components ?? [];
    expect(components.some((c) => c.category === "cooler" && c.included)).toBe(true);
    expect(components.filter((c) => c.category === "storage")).toHaveLength(2);
    expect(components.some((c) => c.category === "motherboard")).toBe(true);
  });

  it("presents a build whose part was only searched this turn, carrying the validation it was shown from", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    const owned = { ram: { name: "16GB DDR5", owned: true }, storage: { name: "1TB NVMe SSD", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } };
    // The CPU was validated; the board only came back from a search (Lightning r29 esports).
    await validate.execute!({ builds: [{ label: "Esports", parts: { cpu: { product_id: FULL_CPU }, ...owned } }] }, ctx);
    const revalidate = (label: string, parts: Record<string, unknown>) => Promise.resolve(validate.execute!({ builds: [{ label, parts }] } as never, ctx));
    const ids = [FULL_CPU.slice(0, 10), FULL_BOARD.slice(0, 10)];
    const unfound = (await createPresentBuildTool(store, { revalidate }).execute!({ builds: [{ label: "Esports", product_ids: ids }] }, ctx)) as { presented: boolean };
    expect(unfound.presented).toBe(false);

    const found = new Map([[FULL_BOARD, "motherboard"]]);
    const out = (await createPresentBuildTool(store, { revalidate, found }).execute!({ builds: [{ label: "Esports", product_ids: ids }] }, ctx)) as {
      presented: boolean;
      builds: Array<{ product_ids: string[]; validation: { snapshot: { components: Array<{ product_id?: string }> } } }>;
    };
    expect(out.presented).toBe(true);
    expect(out.builds[0].validation.snapshot.components.map((c) => c.product_id)).toEqual(expect.arrayContaining([FULL_CPU, FULL_BOARD]));
    // The model sees what was shown, not the validation the card draws.
    expect((toModelPresentOutput(out) as { builds: object[] }).builds[0]).not.toHaveProperty("validation");
  });

  it("keeps a part owned when present_build rebuilds the build from IDs", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store, { userText: "I have an i9-14900K, 16GB DDR5, a 750W PSU, an ATX case and two SSDs: a 1TB NVMe and a 2TB SATA" });
    const owned = { ram: { name: "16GB DDR5", owned: true }, storage: [{ name: "1TB NVMe SSD", owned: true }, { name: "2TB SATA SSD", owned: true }], psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } };
    await validate.execute!({ builds: [{ label: "Upgrade", parts: { cpu: { product_id: FULL_CPU, owned: true }, ...owned } }] }, ctx);
    const revalidate = (label: string, parts: Record<string, unknown>) => Promise.resolve(validate.execute!({ builds: [{ label, parts }] } as never, ctx));
    const found = new Map([[FULL_BOARD, "motherboard"]]);
    const out = (await createPresentBuildTool(store, { revalidate, found }).execute!({ builds: [{ label: "Upgrade", product_ids: [FULL_CPU.slice(0, 10), FULL_BOARD.slice(0, 10)] }] }, ctx)) as {
      presented: boolean;
      builds: Array<{ validation: { snapshot: { total: number; components: Array<{ category: string; owned?: boolean }> } } }>;
    };
    expect(out.presented).toBe(true);
    const components = out.builds[0].validation.snapshot.components;
    expect(components.find((c) => c.category === "cpu")?.owned).toBe(true);
    expect(components.filter((c) => c.category === "storage" && c.owned)).toHaveLength(2);
    // Only the board is bought.
    expect(out.builds[0].validation.snapshot.total).toBe(45000);
  });

  it("refuses a build with an owned part the user never named, and tells the model why", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store, { userText: "Office PC under ₹35,000, I have a 1TB NVMe SSD" });
    const parts = { cpu: { name: "Intel Core i9-14900K", owned: true }, motherboard: { product_id: FULL_BOARD }, storage: { name: "1TB NVMe SSD", owned: true } };
    const out = (await validate.execute!({ builds: [{ label: "Cheap", parts }] }, ctx)) as { builds: Record<string, { unnamed_owned?: string[] }> };
    // The SSD is named by the user; the CPU isn't.
    expect(out.builds.Cheap.unnamed_owned).toEqual(['cpu "Intel Core i9-14900K"']);
    const present = createPresentBuildTool(store);
    const refused = (await present.execute!({ builds: [{ label: "Cheap" }] }, ctx)) as { presented: boolean; error: string };
    expect(refused).toMatchObject({ presented: false, error: expect.stringContaining("hasn't said they own cpu") });

    // An owned part passed by ID alone is checked by its catalog name.
    const byId = (await validate.execute!({ builds: [{ label: "By ID", parts: { ...parts, cpu: { product_id: FULL_CPU, owned: true } } }] }, ctx)) as { builds: Record<string, { unnamed_owned?: string[] }> };
    expect(byId.builds["By ID"].unnamed_owned).toEqual(['cpu "Intel Core i9-14900K Desktop Processor"']);
  });

  it("notes a gaming build with no graphics card, unless the user ruled one out", async () => {
    expect(wantsGamingGpu("Build me a gaming PC for 1080p esports games like Valorant within ₹60,000.")).toBe(true);
    expect(wantsGamingGpu("I already have an RTX 3070. Build the rest for ₹70,000 and don't include a graphics card.")).toBe(false);
    expect(wantsGamingGpu("Basic PC for office work and Python coding, ₹35,000.")).toBe(false);

    const parts = { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD } };
    const gaming = createValidateBuildTool(scope, repo, createTurnValidationStore(), { userText: "Gaming PC for 1080p esports, ₹60,000" });
    const out = await gaming.execute!({ builds: [{ label: "iGPU", parts }] }, ctx);
    const view = toModelValidateOutput(out) as { builds: Record<string, Record<string, unknown>> };
    // The note leads the model's view of the build.
    expect(Object.keys(view.builds.iGPU)[0]).toBe("gpu_note");
    const office = createValidateBuildTool(scope, repo, createTurnValidationStore(), { userText: "Office PC, ₹35,000" });
    expect((await office.execute!({ builds: [{ label: "iGPU", parts }] }, ctx)) as object).not.toHaveProperty("builds.iGPU.gpu_note");
  });

  it("presents by label only, storing full IDs", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    await validate.execute!(
      { builds: [{ label: "Within budget", parts: { cpu: { product_id: FULL_CPU.slice(0, 10) }, motherboard: { product_id: FULL_BOARD.slice(0, 10) }, ram: { name: "16GB DDR5", owned: true }, storage: { name: "1TB NVMe SSD", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } } }] },
      ctx
    );
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Within budget" }] }, ctx)) as {
      presented: boolean;
      builds: Array<{ product_ids: string[] }>;
    };
    expect(out.presented).toBe(true);
    expect(out.builds[0].product_ids).toContain(FULL_CPU);
    expect(out.builds[0].product_ids).toContain(FULL_BOARD);
  });

  it("refuses builds with blocking issues", async () => {
    const store = createTurnValidationStore();
    const { recordValidation } = await import("../turn-state");
    const snapshot = {
      label: "Blocked",
      components: [
        { category: "cpu", product_id: FULL_CPU, name: "CPU", price: 1, currency: "INR" },
        { category: "motherboard", product_id: FULL_BOARD, name: "Board", price: 1, currency: "INR" }
      ],
      total: 2,
      subtotal: 2,
      currency: "INR",
      is_complete: true,
      component_count: 2,
      unpriced_count: 0,
      missing_prices: [],
      currencies: ["INR"],
      parts: {},
      valid: false,
      created_at: new Date().toISOString()
    } as never;
    recordValidation(store, "Blocked", {
      valid: false,
      issues: [{ rule: "socket", severity: "blocking", detail: "Socket mismatch", components: ["cpu"] }],
      resolved: {},
      checks: [],
      summary: { passed: 0, failed: 1, unverified: 0, text: "1 failed" },
      snapshot
    } as never);
    const present = createPresentBuildTool(store);
    const out = (await present.execute!({ builds: [{ label: "Blocked" }] }, ctx)) as {
      presented: boolean;
      error: string;
    };
    expect(out.presented).toBe(false);
    expect(out.error).toMatch(/blocking/i);
  });

  it("refuses IDs differing from the validation snapshot", async () => {
    const store = createTurnValidationStore();
    const validate = createValidateBuildTool(scope, repo, store);
    await validate.execute!(
      { builds: [{ label: "Within budget", parts: { cpu: { product_id: FULL_CPU }, motherboard: { product_id: FULL_BOARD }, ram: { name: "16GB DDR5", owned: true }, storage: { name: "1TB NVMe SSD", owned: true }, psu: { name: "750W PSU", owned: true }, case: { name: "ATX case", owned: true } } }] },
      ctx
    );
    const present = createPresentBuildTool(store);
    const other = "6f5ed45a50ad56603d3534d036036a55749156dc";
    insert(db, { id: other, name: "AMD Ryzen 7 7800X3D Processor", category: "cpu", registry_key: "amd-ryzen-7-7800x3d", price: 38000, country_code: "IN" });
    const out = (await present.execute!(
      { builds: [{ label: "Within budget", product_ids: [other.slice(0, 10), FULL_BOARD.slice(0, 10)] }] },
      ctx
    )) as { presented: boolean; error: string };
    expect(out.presented).toBe(false);
    expect(out.error).toMatch(/differ/i);
  });
});
