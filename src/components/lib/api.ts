import type {
  ChainEntry,
  CredentialAvailability,
  DiscoveredModel,
  EndpointPreset,
  Persona,
  Personality,
  PingResult,
  ProfileSummary,
  SessionSummary,
  StatusResponse,
  ThemeFile
} from "./types";
import type { ChatUIMessage } from "../chat/message";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Request to ${url} failed: HTTP ${response.status}`);
  return (await response.json()) as T;
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

export async function fetchPersonas(): Promise<Persona[]> {
  const data = await getJson<{ personas: Persona[] }>("/api/personas");
  return data.personas;
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
  const response = await fetch("/api/llm/probe", {
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
  });
  return (await response.json()) as PingResult;
}

export type ImportResult =
  | { ok: true; filename?: string; profileName?: string }
  | { ok: false; errors: string[] };

export async function importProfileFromFile(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/profiles/import", { method: "POST", body: form });
  return normalizeImportResponse(response);
}

export async function importProfileFromUrl(url: string): Promise<ImportResult> {
  const response = await fetch("/api/profiles/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
  return normalizeImportResponse(response);
}

async function normalizeImportResponse(response: Response): Promise<ImportResult> {
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok && (data.ok ?? true)) {
    return { ok: true, filename: data.filename as string | undefined, profileName: data.profileName as string | undefined };
  }
  const errors = Array.isArray(data.errors)
    ? (data.errors as unknown[]).map((error) => (typeof error === "string" ? error : JSON.stringify(error)))
    : [typeof data.message === "string" ? data.message : `Import failed (HTTP ${response.status}).`];
  return { ok: false, errors };
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
 * for each `event:`/`data:` frame. Resolves when the stream closes.
 */
export async function postSse(
  url: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal
): Promise<void> {
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
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) emitFrame(frame, onEvent);
    }
    if (buffer.trim()) emitFrame(buffer, onEvent);
  } finally {
    reader.releaseLock();
  }
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
  title: string | null;
  created_at: string;
  updated_at: string;
  country_code: string | null;
  currency: string | null;
  messages: ChatUIMessage[];
  build_state: unknown | null;
};

export type SaveSessionRequest = {
  id: string;
  messages: ChatUIMessage[];
  title?: string;
  countryCode?: string;
  currency?: string;
};

export async function fetchSessions(): Promise<SessionSummary[]> {
  const data = await getJson<{ sessions: SessionSummary[] }>("/api/sessions");
  return data.sessions;
}

export async function fetchSession(id: string): Promise<SessionDetail | null> {
  const data = await getJson<{ session: SessionDetail | null }>(`/api/sessions/${id}`);
  return data.session;
}

export async function saveSession(input: SaveSessionRequest): Promise<void> {
  await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
}
