import path from "node:path";
import { z } from "zod";
import { validateAndWriteProfile, type ProfileImportResult } from "../../_lib/profile-import";
import { badRequest, InvalidJsonError, json, readJson, serverError } from "../../_lib/responses";
import { assertSafeFetchUrl, UnsafeUrlError } from "../../_lib/url-guard";
import { guardHostedRoute } from "@/lib/middleware/route-guard";

export const runtime = "nodejs";

const importSchema = z.union([
  z.object({ profile: z.unknown(), filename: z.string().optional() }),
  z.object({ url: z.string().url(), filename: z.string().optional() })
]);

export async function POST(request: Request): Promise<Response> {
  const blocked = guardHostedRoute(request);
  if (blocked) return blocked;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      return await importFormData(await request.formData());
    }

    const body = importSchema.parse(await readJson(request));
    if ("url" in body) {
      const url = assertSafeFetchUrl(body.url);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
      const response = await fetch(url, { signal });
      if (!response.ok) return json({ error: "profile_fetch_failed", status: response.status }, { status: 400 });
      return writeProfile(await readFetchedJson(response), body.filename ?? path.posix.basename(url.pathname));
    }
    return writeProfile(body.profile, body.filename);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof InvalidJsonError || error instanceof UnsafeUrlError) return badRequest(error);
    return serverError(error);
  }
}

async function importFormData(formData: FormData): Promise<Response> {
  const file = formData.get("file");
  if (!(file instanceof File)) return json({ error: "invalid_request", message: "Expected multipart file field named file." }, { status: 400 });
  return writeProfile(parseProfileJson(await file.text()), file.name);
}

function writeProfile(profile: unknown, filename?: string): Response {
  return profileImportResponse(validateAndWriteProfile(profile, { filename }));
}

export function profileImportResponse(result: ProfileImportResult): Response {
  if (!result.ok && result.error === "profile_exists") {
    return json(
      { error: "profile_exists", message: `A profile with id "${result.id}" already exists.`, id: result.id },
      { status: 409 }
    );
  }
  if (!result.ok) return json({ error: result.error, errors: result.errors }, { status: 400 });
  return json(result);
}

function parseProfileJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError("Profile file must contain valid JSON.");
  }
}

async function readFetchedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error("profile_fetch_failed");
  }
  try {
    return await response.json();
  } catch {
    throw new InvalidJsonError("Fetched profile must contain valid JSON.");
  }
}
