import type { BuildSnapshot } from "../catalog/build-snapshot";
import type { ValidationResult } from "../rules-engine";

export type TurnValidationEntry = {
  label: string;
  validation: ValidationResult & { snapshot: BuildSnapshot };
  snapshot: BuildSnapshot;
  /** Full catalog product IDs from the validation snapshot. */
  productIds: string[];
};

export type TurnValidationStore = Map<string, TurnValidationEntry>;

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function createTurnValidationStore(): TurnValidationStore {
  return new Map();
}

export function validLabels(store: TurnValidationStore): string[] {
  return [...store.values()].map((entry) => entry.label);
}

function snapshotIds(snapshot: BuildSnapshot): string[] {
  if (!snapshot || !Array.isArray(snapshot.components)) return [];
  return snapshot.components
    .map((c) => c?.product_id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

export function recordValidation(
  store: TurnValidationStore,
  label: string,
  validation: ValidationResult & { snapshot: BuildSnapshot }
): void {
  const snapshot = validation.snapshot;
  store.set(normalizeLabel(label), {
    label,
    validation,
    snapshot,
    productIds: snapshotIds(snapshot)
  });
}
