import { ZodError } from "zod";
import { SandboxedPathError } from "./paths";

export class InvalidJsonError extends Error {
  constructor(message = "Request body must be valid JSON.") {
    super(message);
    this.name = "InvalidJsonError";
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function badRequest(error: unknown): Response {
  if (error instanceof ZodError) {
    return json({ error: "invalid_request", issues: error.issues }, { status: 400 });
  }
  if (error instanceof InvalidJsonError || error instanceof SandboxedPathError) {
    return json({ error: "invalid_request", message: error.message }, { status: 400 });
  }
  return json({ error: "invalid_request", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidJsonError();
  }
}

export function serverError(error: unknown): Response {
  return json({ error: "server_error", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
}
