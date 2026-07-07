import { createHash } from "node:crypto";

export function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}
