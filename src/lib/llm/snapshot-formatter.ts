import type { BuildSnapshot } from "../catalog/build-snapshot";

export function formatSnapshotForContext(snapshot: BuildSnapshot): string {
  const partsList = snapshot.components
    .map((c) => {
      const priceStr = c.price !== null ? `${c.currency} ${c.price}` : "Price unknown / unlisted";
      const retailerStr = c.retailer ? ` (Retailer: ${c.retailer})` : "";
      const idStr = c.product_id ? ` [ID: ${c.product_id}]` : "";
      const includedStr = c.included ? ` [Included with CPU: ${snapshot.currency} 0]` : ` — ${priceStr}${retailerStr}`;
      return `- ${c.category.toUpperCase()}: ${c.name}${idStr}${includedStr}`;
    })
    .join("\n");

  const totalStr =
    snapshot.total !== null
      ? `Total: ${snapshot.currency} ${snapshot.total}`
      : `Subtotal (known prices): ${snapshot.currency} ${snapshot.subtotal}${
          snapshot.missing_prices.length > 0 ? ` (Missing/unresolved prices for: ${snapshot.missing_prices.join(", ")})` : ""
        }`;

  let compatibilityStr = "Compatibility: ";
  if (snapshot.validation_summary) {
    const { failed, unverified, passed, skipped } = snapshot.validation_summary;
    if (failed > 0) {
      compatibilityStr += `FAILED (${failed} failed check(s))`;
    } else if (unverified > 0 || skipped > 0) {
      const pending: string[] = [];
      if (unverified > 0) pending.push(`${unverified} unverified check(s)`);
      if (skipped > 0) pending.push(`${skipped} skipped check(s)`);
      compatibilityStr += `UNVERIFIED (${pending.join(", ")}; no failing checks)`;
    } else {
      compatibilityStr += `PASSED (${passed} check(s) verified)`;
    }
  } else {
    compatibilityStr += snapshot.valid ? "PASSED" : "PENDING/ISSUES";
  }

  return [
    `Current Build Snapshot (Code-Calculated, Authoritative):`,
    snapshot.label ? `Label: ${snapshot.label}` : "",
    compatibilityStr,
    totalStr,
    `Components (${snapshot.component_count}):`,
    partsList
  ]
    .filter(Boolean)
    .join("\n");
}
