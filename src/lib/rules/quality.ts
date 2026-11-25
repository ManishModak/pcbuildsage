/**
 * src/lib/rules/quality.ts
 *
 * Deterministic part-quality and intent checks:
 * 1. PSU quality floor (blocks unbranded / dangerously cheap unrated PSUs;
 *    flags bare-budget PSUs in quiet/silent builds).
 * 2. Case airflow gate under dedicated gaming GPUs (blocks fanless cases).
 * 3. Compact / SFF form-factor check (flags ATX mid/full-tower cases when
 *    userText requests compact / small / mini / SFF).
 * 4. Boxed CPU stock-cooler honesty (blocks claimed stock cooler when CPU
 *    includes none; advises against redundant paid coolers on stock-cooled CPUs).
 */
import { canonicalizeFormFactor } from "../spec-canonical";
import { parseCpuPackage } from "../spec-parsers";
import type { ComponentCategory, ResolvedSpec } from "../registry";
import type { BuildIssue, BuildPart } from "../rules-engine";
import { isStockCooler, type CheckRecorder } from "./shared";

export type ComponentQualityMeta = {
  price?: number | null;
  currency?: string;
  name?: string;
  owned?: boolean;
  specs?: Record<string, unknown> | null;
};

export type QualityCheckContext = {
  userText?: string;
  currency?: string;
  componentMeta?: Partial<Record<ComponentCategory, ComponentQualityMeta>>;
};

export type CpuCoolerStatus = "included" | "not_included" | "unknown";

const GAMING_REQUEST = /\b(gaming|games?|esports|fps|valorant|cs2|gta|aaa)\b/i;
const NO_GPU_REQUEST = /\b(no|without|don'?t (?:need|want|include))\s+(?:a\s+|any\s+)?(?:dedicated\s+|separate\s+)?(?:gpu|graphics)/i;
const QUIET_REQUEST = /\b(quiet|silent|silence|low[- ]?noise|whisper|noise[- ]?free)\b/i;
const COMPACT_REQUEST = /\b(compact|sff|small[\s-]+form[\s-]+factor|mini[\s-]?itx|mini[\s-]+pc|small[\s-]+(?:pc|build|case|cabinet|chassis|desktop|footprint|desk)|tiny[\s-]+(?:pc|build|case))\b/i;
const OVERCLOCK_REQUEST = /\b(overclock(?:ing)?|oc\b|pbo|heavy\s+render|sustained\s+all-core)\b/i;

/** True when the user's words ask for gaming and don't rule out a graphics card. */
export function wantsGamingGpu(userText: string): boolean {
  return GAMING_REQUEST.test(userText) && !NO_GPU_REQUEST.test(userText);
}

/** True when the user explicitly asks for a quiet / silent build. */
export function wantsQuietBuild(userText?: string): boolean {
  return Boolean(userText && QUIET_REQUEST.test(userText));
}

/** True when the user explicitly asks for a compact / SFF / mini PC. */
export function wantsCompactBuild(userText?: string): boolean {
  return Boolean(userText && COMPACT_REQUEST.test(userText));
}

/** True when the user asks for overclocking or sustained heavy thermal loads. */
export function wantsOverclocking(userText?: string): boolean {
  return Boolean(userText && OVERCLOCK_REQUEST.test(userText));
}

const KNOWN_PSU_BRAND_OR_SERIES =
  /\b(deepcool|deep\s+cool|msi|corsair|cooler\s*master|coolermaster|antec|gigabyte|aorus|seasonic|super\s*flower|superflower|evga|thermaltake|nzxt|be\s*quiet!?|bequiet|silverstone|asus|rog|tuf|lian\s*li|lianli|fsp|montech|xpg|adata|fractal\s+design|phanteks|cougar|enermax|pk[4-7]50d|pf[4-7]50|pl[4-7]50d|pm\d{3,4}d|dq\d{3,4}|mag\s*a[4-8]50b[en]?|mag\s*a[6-8]50gl|cx[4-8]50|cv[4-7]50|rm[5-9]50[ex]?|rm1000[ex]?|mwe\s*\d{3,4}|p[4-7]50b|focus\s*gx|pure\s*power|straight\s*power|dark\s*power|toughpower|leadex)\b/i;

const EXPLICIT_GENERIC_PSU =
  /\b(generic|unbranded|no[- ]?name|noname|local\s+smps|oem\s+smps)\b/i;

const QUIET_PSU_SIGNAL =
  /\b(be\s*quiet!?|bequiet|quiet|silent|zero[- ]?rpm|fanless|semi[- ]?passive|80\s*(?:\+|plus)\s*(?:gold|platinum|titanium))\b/i;

const ZERO_FANS_TITLE =
  /\b(no\s+fans?(?!\s+(?:controller|hub|splitter))|without\s+(?:any\s+)?fans?(?!\s+(?:controller|hub|splitter))|0\s*x?\s*fans?|zero\s+fans?|fans?\s+not\s+included|fanless|w\/o\s+fans?|no\s+pre-?installed\s+fans?)\b/i;

const NO_STOCK_COOLER_SKU =
  /\b(?:i[3579][-\s]?\d{4,5}k[fs]?|ultra\s*[3579]\s*\d{3}k[fs]?|ryzen\s*[3579]\s*\d{4}x3d|ryzen\s*[579]\s*[79]\d{3}x|ryzen\s*[79]\s*5[789]00x)\b/i;

const BOXED_STOCK_COOLER_SKU: Array<{ pattern: RegExp; key: string; model: string; tdp_rating_w: number }> = [
  {
    pattern: /\bryzen\s*[79]\s*(?:7700|7900)\b(?!x)/i,
    key: "amd-wraith-prism",
    model: "AMD Wraith Prism",
    tdp_rating_w: 105
  },
  {
    pattern: /\bryzen\s*[357]\s*(?:3600|4500|5500|5600|5600x|5600g|5600gt|5500gt|5700g|7600|8500g|8600g|8700g)\b(?!x3d)/i,
    key: "amd-wraith-stealth",
    model: "AMD Wraith Stealth",
    tdp_rating_w: 65
  },
  {
    pattern: /\bi[35][-\s]?(?:12100|12400|12500|13100|13400|13500|14100|14400|14500)f?\b/i,
    key: "intel-laminar-rm1",
    model: "Intel Laminar RM1",
    tdp_rating_w: 65
  }
];

function productDescriptorText(spec: ResolvedSpec, meta?: ComponentQualityMeta): string {
  return [
    spec.spec.brand,
    spec.spec.model,
    ...(Array.isArray(spec.spec.aliases) ? spec.spec.aliases : []),
    meta?.name
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

function combinedText(spec: ResolvedSpec, meta?: ComponentQualityMeta): string {
  return [spec.key, productDescriptorText(spec, meta)]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

function resolvePrice(spec: ResolvedSpec, meta?: ComponentQualityMeta): number | undefined {
  if (typeof meta?.price === "number" && Number.isFinite(meta.price)) return meta.price;
  if (typeof spec.spec.price === "number" && Number.isFinite(spec.spec.price)) return spec.spec.price;
  return undefined;
}

function resolveCurrency(spec: ResolvedSpec, meta?: ComponentQualityMeta, fallback?: string): string {
  const raw = meta?.currency ?? (typeof spec.spec.currency === "string" ? spec.spec.currency : undefined) ?? fallback ?? "INR";
  return raw.toUpperCase();
}

export function evaluatePsuQuality(params: {
  text: string;
  quietText?: string;
  efficiency?: string;
  price?: number;
  currency: string;
  hasWattage?: boolean;
  userText?: string;
}): { blockingReason?: string; quietAdvisory?: string } {
  const { text, quietText = text, efficiency, price, currency, hasWattage = true, userText } = params;
  const has80Plus = Boolean(
    (efficiency && /80\s*(?:\+|plus)/i.test(efficiency)) ||
    /\b80\s*(?:\+|(?:pro\s+)?plus)\b/i.test(text) ||
    /\bcybenetics\b/i.test(text)
  );
  const hasKnownBrand = KNOWN_PSU_BRAND_OR_SERIES.test(text);
  const isGeneric = EXPLICIT_GENERIC_PSU.test(text);

  const isInr = currency === "INR";
  const isUsd = currency === "USD";
  const standardFloor = isInr ? 2000 : isUsd ? 25 : undefined;
  const ultraCheapFloor = isInr ? 1200 : isUsd ? 15 : undefined;
  const quietFloor = isInr ? 3500 : isUsd ? 50 : undefined;

  const belowStandardPrice =
    price !== undefined &&
    standardFloor !== undefined &&
    ultraCheapFloor !== undefined &&
    ((price < standardFloor && !has80Plus && !hasKnownBrand) || (price < ultraCheapFloor && !hasKnownBrand));

  const unpricedGeneric = price === undefined && isGeneric && !has80Plus && !hasKnownBrand && hasWattage;

  if (belowStandardPrice || unpricedGeneric) {
    return {
      blockingReason:
        "fails the PSU quality floor: unbranded or ultra-budget power supplies without 80 Plus certification or a reputable PSU series risk instability and hardware damage. Pick an 80 Plus certified unit from a reputable brand (e.g. Corsair CX/CV, MSI MAG A-BN, DeepCool PK-D, Cooler Master MWE, Seasonic, Antec)."
    };
  }

  if (wantsQuietBuild(userText)) {
    const isQuietRated = Boolean(
      QUIET_PSU_SIGNAL.test(quietText) ||
      (efficiency && /\b(gold|platinum|titanium)\b/i.test(efficiency))
    );
    if (!isQuietRated) {
      if (price !== undefined && quietFloor !== undefined && price < quietFloor) {
        return {
          quietAdvisory:
            `Quiet-build PSU warning: this bare-budget PSU (${currency === "INR" ? `₹${price.toLocaleString("en-IN")}` : `${currency} ${price}`}) is likely to have louder fan acoustics under load. For a quiet/silent build, pick a quieter reputable unit (e.g. be quiet!, Corsair RM/CX, Cooler Master MWE Gold, Seasonic, or an 80+ Gold semi-fanless PSU).`
        };
      }
      if (price === undefined && !has80Plus) {
        return {
          quietAdvisory:
            "Quiet-build PSU warning: this uncertified PSU may have loud fan acoustics. For a quiet/silent build, pick a quieter 80+ Bronze/Gold unit from a reputable brand."
        };
      }
    }
  }

  return {};
}

/** True when a case spec or title explicitly states zero included fans. */
export function isFanlessCase(pcCase: ResolvedSpec, meta?: ComponentQualityMeta): boolean {
  const specFans = meta?.specs?.included_fans ?? pcCase.spec.included_fans;
  if (specFans === 0 || specFans === "0") return true;
  return ZERO_FANS_TITLE.test(combinedText(pcCase, meta));
}

/**
 * True when a case is an ATX mid-tower or full-tower rather than a
 * Mini-ITX / compact Micro-ATX / SFF chassis.
 */
export function isAtxMidOrFullTower(pcCase: ResolvedSpec, meta?: ComponentQualityMeta): boolean {
  const text = combinedText(pcCase, meta);
  const formFactors = Array.isArray(pcCase.spec.form_factors)
    ? pcCase.spec.form_factors.map((f) => canonicalizeFormFactor(String(f)))
    : [];
  const supportsAtxOrLarger =
    formFactors.includes("atx") || formFactors.includes("e-atx") || formFactors.includes("xl-atx");

  if (formFactors.length > 0 && !supportsAtxOrLarger) {
    // Strictly Micro-ATX / Mini-ITX / Mini-DTX chassis — compact enough.
    return false;
  }

  const explicitlyCompactAtx = /\b(sff|small[\s-]+form[\s-]+factor|compact)\b/i.test(text) && !/\bmid[\s-]?tower\b/i.test(text);
  if (explicitlyCompactAtx) return false;

  if (supportsAtxOrLarger) return true;

  const isMiniOrMicroTitle = /\b(mini[\s-]?itx|micro[\s-]?atx|m[\s-]?atx|mini[\s-]+tower|cube|slim)\b/i.test(text);
  return (
    /\b(full[\s-]?tower|mid[\s-]?tower)\b/i.test(text) ||
    (/\batx\b/i.test(text) && !isMiniOrMicroTitle)
  );
}

/**
 * Determines whether a CPU includes a stock cooler:
 * explicit `includes_cooler` / `cooler_included` specs win, then title
 * packaging keywords, then known retail CPU SKUs.
 */
export function getCpuCoolerInclusion(
  cpu: ResolvedSpec,
  meta?: ComponentQualityMeta
): { status: CpuCoolerStatus; stockCooler?: { key: string; model: string; tdp_rating_w: number } } {
  const specIncludes = meta?.specs?.includes_cooler ?? cpu.spec.includes_cooler;
  const specCoolerIncluded = meta?.specs?.cooler_included ?? cpu.spec.cooler_included;

  if (specIncludes === false || specCoolerIncluded === "not_included") {
    return { status: "not_included" };
  }

  const text = combinedText(cpu, meta);
  if (specIncludes === true || specCoolerIncluded === "included") {
    const matched = BOXED_STOCK_COOLER_SKU.find((entry) => entry.pattern.test(text));
    const coolerName = typeof cpu.spec.cooler_name === "string" ? cpu.spec.cooler_name : matched?.model;
    return {
      status: "included",
      ...(matched
        ? { stockCooler: matched }
        : coolerName
          ? { stockCooler: { key: "included-stock-cooler", model: coolerName, tdp_rating_w: 65 } }
          : {})
    };
  }

  if (meta?.name || typeof cpu.spec.model === "string") {
    const pkg = parseCpuPackage(meta?.name ?? String(cpu.spec.model));
    if (pkg.cooler_included === "not_included") return { status: "not_included" };
    if (pkg.cooler_included === "included") {
      const matched = BOXED_STOCK_COOLER_SKU.find((entry) => entry.pattern.test(text));
      return {
        status: "included",
        ...(matched
          ? { stockCooler: matched }
          : pkg.cooler_name
            ? { stockCooler: { key: "included-stock-cooler", model: pkg.cooler_name, tdp_rating_w: 65 } }
            : {})
      };
    }
  }

  if (NO_STOCK_COOLER_SKU.test(text)) {
    return { status: "not_included" };
  }

  const boxed = BOXED_STOCK_COOLER_SKU.find((entry) => entry.pattern.test(text));
  if (boxed) {
    return { status: "included", stockCooler: boxed };
  }

  return { status: "unknown" };
}

export function isOwnedBuildPart(part: BuildPart | undefined, meta?: ComponentQualityMeta): boolean {
  return Boolean(meta?.owned || (part && typeof part === "object" && part.owned === true));
}

export function hasProductId(part: BuildPart | undefined): boolean {
  return Boolean(part && typeof part === "object" && typeof part.product_id === "string" && part.product_id.trim().length > 0);
}

/**
 * Runs PSU quality, fanless-case-under-gaming-GPU, and compact-case checks.
 */
export function checkBuildQuality(params: {
  psu: ResolvedSpec | undefined;
  pcCase: ResolvedSpec | undefined;
  gpu: ResolvedSpec | undefined;
  motherboard: ResolvedSpec | undefined;
  parts: Partial<Record<ComponentCategory, BuildPart | BuildPart[]>>;
  context: QualityCheckContext;
  recordCheck: CheckRecorder;
  issues: BuildIssue[];
}): void {
  const { psu, pcCase, gpu, motherboard, parts, context, recordCheck, issues } = params;
  const meta = context.componentMeta ?? {};

  if ((psu || meta.psu) && parts.psu && !isOwnedBuildPart(parts.psu as BuildPart | undefined, meta.psu)) {
    const psuKey = psu?.key ?? (typeof parts.psu === "string" ? parts.psu : (parts.psu as { product_id?: string; key?: string; name?: string }).product_id ?? (parts.psu as { key?: string }).key ?? (parts.psu as { name?: string }).name ?? "psu");
    const psuName = meta.psu?.name ?? psu?.spec.model ?? psuKey;
    const efficiency =
      (meta.psu?.specs && typeof meta.psu.specs.efficiency === "string" ? meta.psu.specs.efficiency : undefined) ??
      (typeof psu?.spec.efficiency === "string" ? psu.spec.efficiency : undefined);
    const hasWattage = typeof (psu?.spec.wattage ?? psu?.spec.wattage_w) === "number";
    const psuText = psu ? combinedText(psu, meta.psu) : (meta.psu?.name ?? psuKey);
    const psuQuietText = psu ? productDescriptorText(psu, meta.psu) : (meta.psu?.name ?? "");
    const psuVerdict = evaluatePsuQuality({
      text: psuText,
      quietText: psuQuietText,
      efficiency,
      price: psu ? resolvePrice(psu, meta.psu) : (typeof meta.psu?.price === "number" ? meta.psu.price : undefined),
      currency: psu ? resolveCurrency(psu, meta.psu, context.currency) : ((meta.psu?.currency ?? context.currency ?? "INR").toUpperCase()),
      hasWattage,
      userText: context.userText
    });
    if (psuVerdict.blockingReason) {
      recordCheck("quality", "failed", [psuKey], `${psuName} ${psuVerdict.blockingReason}`);
    } else if (psu) {
      recordCheck("quality", "passed", [psuKey], `${psuName} meets the PSU quality floor.`);
      if (psuVerdict.quietAdvisory) {
        issues.push({
          severity: "advisory",
          rule: "quality",
          components: [psuKey],
          detail: psuVerdict.quietAdvisory
        });
      }
    } else if (psuVerdict.quietAdvisory) {
      issues.push({
        severity: "advisory",
        rule: "quality",
        components: [psuKey],
        detail: psuVerdict.quietAdvisory
      });
    }
  }

  const effectiveCase: ResolvedSpec | undefined =
    pcCase ??
    (parts.case && meta.case
      ? {
          key: typeof parts.case === "string" ? parts.case : ((parts.case as { product_id?: string; key?: string; name?: string }).product_id ?? (parts.case as { key?: string }).key ?? meta.case.name ?? "case"),
          category: "case",
          spec: { brand: "", model: meta.case.name ?? "", aliases: [], ...(meta.case.specs ?? {}) },
          source: "registry",
          confidence: "low"
        }
      : undefined);

  if (effectiveCase) {
    const caseName = meta.case?.name ?? effectiveCase.spec.model ?? effectiveCase.key;
    const gpuTdp = typeof gpu?.spec.tdp_w === "number" ? gpu.spec.tdp_w : undefined;
    const gpuSegment = typeof gpu?.spec.segment === "string" ? gpu.spec.segment.toLowerCase() : undefined;
    const isDisplayOnlyGpu = gpuSegment === "display" && (gpuTdp === undefined || gpuTdp < 75) && !wantsGamingGpu(context.userText ?? "");
    const hasGamingOrWarmGpu = Boolean(
      (gpu || parts.gpu) && !isDisplayOnlyGpu && (gpuSegment === "gaming" || (gpuTdp !== undefined && gpuTdp >= 75) || wantsGamingGpu(context.userText ?? "") || gpuTdp === undefined)
    );
    const gpuKey = gpu?.key;

    if (hasGamingOrWarmGpu && isFanlessCase(effectiveCase, meta.case)) {
      const comps = [effectiveCase.key, ...(gpuKey ? [gpuKey] : [])];
      recordCheck(
        "quality",
        "failed",
        comps,
        `Case ${caseName} indicates zero included fans, which provides insufficient airflow for a dedicated gaming GPU${gpu ? ` (${gpu.spec.model || gpu.key})` : ""}. Choose a case with pre-installed fans.`
      );
    } else if (hasGamingOrWarmGpu && pcCase) {
      recordCheck("quality", "passed", [effectiveCase.key, ...(gpuKey ? [gpuKey] : [])], `Case ${caseName} is not flagged as fanless for this GPU build.`);
    }

    if (wantsCompactBuild(context.userText)) {
      const userAskedAtx =
        /\b(compact\s+atx|mid[\s-]?tower)\b/i.test(context.userText ?? "") &&
        !/\b(mini[\s-]?itx|itx|sff|micro[\s-]?atx|m[\s-]?atx)\b/i.test(context.userText ?? "");
      const mbFf = typeof motherboard?.spec.form_factor === "string" ? canonicalizeFormFactor(motherboard.spec.form_factor) : undefined;
      const ownedAtxBoard = Boolean(motherboard && isOwnedBuildPart(parts.motherboard as BuildPart | undefined, meta.motherboard) && (mbFf === "atx" || mbFf === "e-atx"));

      if (!userAskedAtx && isAtxMidOrFullTower(effectiveCase, meta.case)) {
        const msg = ownedAtxBoard
          ? `User requested a compact build while keeping an owned ${motherboard?.spec.form_factor} motherboard; ${caseName} is an ATX mid/full-tower chassis, so confirm physical desk dimensions fit.`
          : `User asked for a compact/SFF build, but ${caseName} is an ATX mid-tower/full-tower case. Pick a Mini-ITX or compact Micro-ATX chassis (with a matching Micro-ATX or Mini-ITX motherboard).`;
        if (ownedAtxBoard) {
          issues.push({ severity: "advisory", rule: "quality", components: [effectiveCase.key], detail: msg });
        } else {
          recordCheck("quality", "failed", [effectiveCase.key], msg);
        }
      }
    }
  }
}

/**
 * Checks whether a CPU + aftermarket cooler pairing triggers a redundant-cooler
 * advisory (when the boxed CPU already ships with an adequate stock cooler in a
 * non-quiet, non-overclocking build).
 */
export function checkRedundantCoolerAdvisory(params: {
  cpu: ResolvedSpec | undefined;
  cooler: ResolvedSpec | undefined;
  cpuMeta?: ComponentQualityMeta;
  coolerMeta?: ComponentQualityMeta;
  coolerPart?: BuildPart;
  userText?: string;
  currency?: string;
  issues: BuildIssue[];
}): void {
  const { cpu, cooler, cpuMeta, coolerMeta, coolerPart, userText, currency, issues } = params;
  if (!cpu || !cooler) return;
  if (isOwnedBuildPart(coolerPart, coolerMeta)) return;
  if (isStockCooler(cooler)) return;

  const inclusion = getCpuCoolerInclusion(cpu, cpuMeta);
  if (inclusion.status !== "included") return;

  const cpuTdp = typeof cpu.spec.tdp_w === "number" ? cpu.spec.tdp_w : 65;
  const stockRating = inclusion.stockCooler?.tdp_rating_w ?? 65;
  if (cpuTdp > stockRating) return;

  if (wantsQuietBuild(userText) || wantsOverclocking(userText)) return;

  const cpuName = cpuMeta?.name ?? cpu.spec.model ?? cpu.key;
  const coolerName = coolerMeta?.name ?? cooler.spec.model ?? cooler.key;
  const coolerPrice = resolvePrice(cooler, coolerMeta);
  const curr = resolveCurrency(cooler, coolerMeta, currency);
  const priceTag = coolerPrice !== undefined && coolerPrice > 0
    ? ` (${curr === "INR" ? `₹${coolerPrice.toLocaleString("en-IN")}` : `${curr} ${coolerPrice}`})`
    : "";
  const stockName = inclusion.stockCooler?.model ? ` (${inclusion.stockCooler.model})` : "";

  issues.push({
    severity: "advisory",
    rule: "cooler",
    components: [cpu.key, cooler.key],
    detail: `${cpuName} already includes a stock cooler${stockName} adequate for its ${cpuTdp}W TDP. Drop the separate ${coolerName}${priceTag} cooler to save budget unless lower noise or extra thermal headroom is specifically wanted.`
  });
}
