import { getCredentialAvailability } from "../_lib/credentials";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json(getCredentialAvailability());
}

