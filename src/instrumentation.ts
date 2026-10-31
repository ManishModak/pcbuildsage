import { warnIfProductionModeUnset } from "@/lib/config/deployment";

export async function register() {
  warnIfProductionModeUnset();
}
