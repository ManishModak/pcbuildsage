import type {
  ChainEntry,
  CredentialAvailability,
  DiscoveredModel,
  EndpointPreset,
  Personality,
  PingResult,
  ProfileSummary,
  SessionSummary,
  StatusResponse,
  ThemeFile
} from "@/types/client";
import type { ChatUIMessage } from "@/features/chat/message";
import { parseRunOutcome, type RunOutcome } from "@/contracts/scrape";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type JsonGuard<T> = (value: unknown) => value is T;

export async function requestJson<T>(url: string, init: RequestInit = {}, guard?: JsonGuard<T>): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new HttpError(`Request to ${url} failed: HTTP ${response.status}`, response.status, null);
    throw new Error(`Request to ${url} returned malformed JSON.`);
  }

  if (!response.ok) {
    const detail = isRecord(body) && typeof body.message === "string" ? `: ${body.message}` : "";
    throw new HttpError(`Request to ${url} failed: HTTP ${response.status}${detail}`, response.status, body);
  }
  if (guard && !guard(body)) throw new Error(`Request to ${url} returned an invalid response.`);
  return body as T;
}

export async function requestOk(url: string, init: RequestInit = {}): Promise<void> {
  await requestJson(url, init, isOkResponse);
}

async function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url);
}

export async function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>("/api/status");
}

export async function fetchCredentials(): Promise<CredentialAvailability> {
  return getJson<CredentialAvailability>("/api/config");
}

export async function fetchProfiles(): Promise<ProfileSummary[]> {
  const data = await getJson<{ profiles: ProfileSummary[] }>("/api/profiles");
  return data.profiles;
}

export async function fetchThemes(): Promise<ThemeFile[]> {
  const data = await getJson<{ themes: ThemeFile[] }>("/api/themes");
  return data.themes;
}

export async function fetchPersonalities(): Promise<Personality[]> {
  const data = await getJson<{ personalities: Personality[] }>("/api/personalities");
  return data.personalities;
}

export async function fetchEndpoints(): Promise<EndpointPreset[]> {
  const data = await getJson<{ endpoints: EndpointPreset[] }>("/api/endpoints");
  return data.endpoints;
}

export async function fetchModels(entry: {
  provider: string;
  baseUrl?: string;
  keySource: string;
  apiKey?: string;
}): Promise<DiscoveredModel[]> {
  const params = new URLSearchParams({ provider: entry.provider, keySource: entry.keySource });
  if (entry.baseUrl) params.set("baseUrl", entry.baseUrl);
  const headers: Record<string, string> = { accept: "application/json" };
  if (entry.apiKey) headers[`x-pcbuildsage-api-key-${entry.provider}`] = entry.apiKey;
  const response = await fetch(`/api/models?${params.toString()}`, { headers });
  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);
  const data = (await response.json()) as { models: DiscoveredModel[] };
  return data.models;
}

export async function probeEntry(
  entry: Pick<ChainEntry, "provider" | "model" | "baseUrl" | "keySource">,
  apiKey?: string
): Promise<PingResult> {
  return requestJson("/api/llm/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { [`x-pcbuildsage-api-key-${entry.provider}`]: apiKey } : {})
    },
    body: JSON.stringify({
      provider: entry.provider,
      model: entry.model,
      baseUrl: entry.baseUrl,
      keySource: entry.keySource,
      ...(apiKey ? { key: apiKey } : {})
    })
  }, isPingResult);
}

export type ImportResult =
  | { ok: true; id: string }
  | { ok: false; errors: string[] };

export async function importProfileFromFile(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  return importProfile({ method: "POST", body: form });
}

export async function importProfileFromUrl(url: string): Promise<ImportResult> {
  return importProfile({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
}

async function importProfile(init: RequestInit): Promise<ImportResult> {
  try {
    return await requestJson("/api/profiles/import", init, isImportSuccess);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { ok: false, errors: errorsFromBody(error.body, error.message) };
  }
}

export async function testProfile(input: {
  profile: string;
  site?: string;
  categories?: string[];
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const response = await fetch("/api/profiles/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: Boolean(data.ok),
    stdout: typeof data.stdout === "string" ? data.stdout : "",
    stderr: typeof data.stderr === "string" ? data.stderr : (typeof data.error === "string" ? data.error : "")
  };
}

/**
 * POST a JSON body and consume a Server-Sent Events response, invoking onEvent
 * for each non-terminal `event:`/`data:` frame. Resolves only when the stream
 * closes after exactly one valid terminal outcome.
 */
export async function postSse(
  url: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal
): Promise<RunOutcome> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    // Surface a structured error (e.g. python_unavailable, single-scrape 409).
    const detail = await response.json().catch(() => ({}));
    onEvent("error", { status: response.status, ...(detail as object) });
    throw new Error(`Scrape request failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const outcomes: RunOutcome[] = [];
  const handleEvent = (event: string, data: unknown) => {
    if (event === "outcome" || (data as { type?: string })?.type === "outcome") {
      const outcome = parseRunOutcome(data);
      if (!outcome) throw new Error("The scrape stream returned an invalid terminal outcome.");
      outcomes.push(outcome);
      return;
    }
    onEvent(event, data);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) emitFrame(frame, handleEvent);
    }
    if (buffer.trim()) emitFrame(buffer, handleEvent);
  } finally {
    reader.releaseLock();
  }
  if (outcomes.length !== 1) {
    throw new Error(
      outcomes.length === 0
        ? "The scrape stream closed without a terminal outcome."
        : "The scrape stream returned more than one terminal outcome."
    );
  }
  return outcomes[0];
}

function emitFrame(frame: string, onEvent: (event: string, data: unknown) => void): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  const raw = dataLines.join("\n");
  try {
    onEvent(event, JSON.parse(raw));
  } catch {
    onEvent(event, raw);
  }
}

export async function exportResearch(): Promise<{ files: string[] }> {
  const response = await fetch("/api/export-research", { method: "POST" });
  if (!response.ok) throw new Error(`Export failed: HTTP ${response.status}`);
  return (await response.json()) as { files: string[] };
}

// --- Chat session history ---------------------------------------------------

export type SessionDetail = {
  id: string;
  revision: number;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  country_code: string | null;
  currency: string | null;
  messages: ChatUIMessage[];
  build_state: unknown | null;
};

export type SaveSessionRequest = {
  id: string;
  revision: number;
  messages: ChatUIMessage[];
  title?: string;
  countryCode?: string;
  currency?: string;
};

interface SessionSummaryRaw {
  id: string;
  title?: string;
  created_at: string | number;
  updated_at: string | number;
  [key: string]: unknown;
}

interface SessionDetailRaw {
  id: string;
  revision: number;
  messages: { createdAt?: string | number; [key: string]: unknown }[];
  created_at: string | number;
  updated_at: string | number;
  [key: string]: unknown;
}

export function normalizeUIMessage(m: unknown, index = 0): ChatUIMessage {
  if (typeof m !== "object" || m === null) {
    return {
      id: `msg-${index}-${crypto.randomUUID()}`,
      role: "user",
      parts: []
    } as ChatUIMessage;
  }
  const rec = m as Record<string, unknown>;
  const id = typeof rec.id === "string" && rec.id ? rec.id : `msg-${index}-${crypto.randomUUID()}`;
  const role = (rec.role === "user" || rec.role === "assistant" || rec.role === "system") ? rec.role : "user";
  const createdAt = rec.createdAt ? new Date(rec.createdAt as string | number) : undefined;

  let parts: ChatUIMessage["parts"] = [];
  if (Array.isArray(rec.parts)) {
    parts = rec.parts as ChatUIMessage["parts"];
  } else if (typeof rec.content === "string") {
    parts = [{ type: "text", text: rec.content }];
  }

  return {
    ...rec,
    id,
    role,
    createdAt,
    parts
  } as ChatUIMessage;
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const data = await getJson<{ sessions: SessionSummaryRaw[] }>("/api/sessions");
  return data.sessions.map((s) => ({
    id: s.id,
    title: s.title ?? null,
    created_at: new Date(s.created_at),
    updated_at: new Date(s.updated_at)
  }));
}

export async function fetchSession(id: string): Promise<SessionDetail | null> {
  const data = await getJson<{ session: SessionDetailRaw | null }>(`/api/sessions/${id}`);
  if (!data.session) return null;
  return {
    id: data.session.id,
    revision: data.session.revision,
    title: (data.session.title as string | undefined) ?? null,
    created_at: new Date(data.session.created_at),
    updated_at: new Date(data.session.updated_at),
    country_code: (data.session.country_code as string | undefined) ?? null,
    currency: (data.session.currency as string | undefined) ?? null,
    build_state: data.session.build_state ?? null,
    messages: Array.isArray(data.session.messages)
      ? data.session.messages.map((m, idx) => normalizeUIMessage(m, idx))
      : []
  };
}

export async function saveSession(input: SaveSessionRequest): Promise<void> {
  await requestJson("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }, (value): value is { ok: true; revision: number } =>
    isRecord(value) && value.ok === true && value.revision === input.revision
  );
}

export async function deleteSession(id: string): Promise<void> {
  await requestOk(`/api/sessions/${id}`, { method: "DELETE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOkResponse(value: unknown): value is { ok: true } {
  return isRecord(value) && value.ok === true;
}

function isImportSuccess(value: unknown): value is { ok: true; id: string } {
  return isRecord(value) && value.ok === true && typeof value.id === "string" && value.id.length > 0;
}

function isPingResult(value: unknown): value is PingResult {
  return isRecord(value)
    && typeof value.reachable === "boolean"
    && typeof value.latencyMs === "number"
    && Number.isFinite(value.latencyMs)
    && typeof value.toolCapable === "boolean"
    && (value.hint === undefined || typeof value.hint === "string");
}

function errorsFromBody(body: unknown, fallback: string): string[] {
  if (!isRecord(body)) return [fallback];
  if (Array.isArray(body.errors)) {
    return body.errors.map((error) => typeof error === "string" ? error : JSON.stringify(error));
  }
  if (typeof body.message === "string") return [body.message];
  return [fallback];
}
