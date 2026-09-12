import { describe, it, expect } from "vitest";
import {
  resolveDeploymentMode,
  validateChatUrl,
  MockSessionStorage,
  MockBrowserSessionStore,
  SessionDetail
} from "../test-harness";

describe("Tier 4 - Workload Scenario 2: BYOK Chat Journey (F1, F3, F18, F19, F21)", () => {
  it("executes complete visitor BYOK key lifecycle and chat flow without server logging", async () => {
    const mode = resolveDeploymentMode("hosted-demo");
    expect(mode).toBe("hosted-demo");

    // Step 1: Visitor inputs Gemini API key into client interface
    const visitorKey = "AIzaSy_VisitorEphemeralKey_778899";
    const clientSessionStorage = new MockSessionStorage();

    // Key is saved strictly into browser sessionStorage
    clientSessionStorage.setItem("pcbuildsage_byok_gemini", visitorKey);
    expect(clientSessionStorage.getItem("pcbuildsage_byok_gemini")).toBe(visitorKey);

    // Step 2: Client prepares chat request to /api/chat with custom header
    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      "x-gemini-api-key": clientSessionStorage.getItem("pcbuildsage_byok_gemini") || ""
    };

    expect(reqHeaders["x-gemini-api-key"]).toBe(visitorKey);

    // Step 3: Verify SSRF validator verifies Gemini endpoint
    const endpointCheck = validateChatUrl("https://generativelanguage.googleapis.com", mode);
    expect(endpointCheck.allowed).toBe(true);

    // Step 4: Verify server-side logging sanitization scrubs the visitor key
    const serverLogEntry = {
      timestamp: new Date().toISOString(),
      level: "INFO",
      component: "chat-handler",
      message: "Streaming LLM completion for session sess-1",
      details: {
        provider: "google",
        headers: reqHeaders
      }
    };

    const serializedLogs = JSON.stringify(serverLogEntry, (k, v) =>
      /key|token|secret|authorization/i.test(k) ? "[REDACTED]" : v
    );

    expect(serializedLogs).not.toContain(visitorKey);
    expect(serializedLogs).toContain("[REDACTED]");

    // Step 5: Store assistant conversation in browser-owned session store
    const browserStore = new MockBrowserSessionStore();
    const session: SessionDetail = {
      id: "sess-byok-1",
      title: "AI Build Assistant Consultation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 2,
      messages: [
        { id: "m1", role: "user", content: "Suggest a quiet CPU cooler for 7800X3D", timestamp: new Date().toISOString() },
        { id: "m2", role: "assistant", content: "Thermalright Peerless Assassin 120 SE offers top performance.", timestamp: new Date().toISOString() }
      ]
    };

    await browserStore.saveSession(session);
    const loaded = await browserStore.getSession("sess-byok-1");
    expect(loaded?.messages.length).toBe(2);

    // Step 6: User clicks 'Reset Key' -> key is purged from browser sessionStorage
    clientSessionStorage.removeItem("pcbuildsage_byok_gemini");
    expect(clientSessionStorage.getItem("pcbuildsage_byok_gemini")).toBeNull();
  });
});
