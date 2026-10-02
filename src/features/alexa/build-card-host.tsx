/**
 * src/features/alexa/build-card-host.tsx
 *
 * MCP Apps host for the build card (spike pattern from
 * `.agent/tasks/hackathon/mcp-card-spike-page.tsx`): one browser MCP client
 * per page to /api/mcp, the `ui://pcbuildsage/build-card` resource read once,
 * rendered in `<iframe sandbox="allow-scripts" srcdoc>`, wired through
 * AppBridge + PostMessageTransport. Each presented `present_build` output is
 * pushed via `sendToolResult`; links open in a new tab.
 *
 * Hosted-demo mode: /api/mcp answers 403 there, so the host shows a short
 * "run locally" notice instead. The hosted allowlist is untouched.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  AppBridge,
  PostMessageTransport,
  getToolUiResourceUri
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { BUILD_CARD_URI_FALLBACK } from "./card-uri";
import type { PresentedBuild } from "./present-cards";

type HostState =
  | { stage: "connecting" }
  | { stage: "ready" }
  | { stage: "blocked"; reason: string };

const HOSTED_NOTICE =
  "Build cards need the local MCP server, which this hosted demo blocks. " +
  "Run the app locally (`npm run dev`) to see full builds — chat still works here.";

export function BuildCardHost({ presentations }: { presentations: PresentedBuild[] }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const clientRef = useRef<Client | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const sentRef = useRef<Set<string>>(new Set());
  // Latest presentations, visible to the bridge's oninitialized handler.
  const latestRef = useRef(presentations);
  useEffect(() => {
    latestRef.current = presentations;
  }, [presentations]);
  const [html, setHtml] = useState<string | null>(null);
  const [height, setHeight] = useState(240);
  const [hostState, setHostState] = useState<HostState>({ stage: "connecting" });

  // One MCP client per page: connect, resolve the card resource, read it once.
  useEffect(() => {
    const client = new Client({ name: "alexa-card-host", version: "0" });
    let cancelled = false;
    void (async () => {
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", window.location.origin)));
        const { tools } = await client.listTools();
        const uri =
          getToolUiResourceUri(tools.find((tool) => tool.name === "present_build") ?? {}) ??
          BUILD_CARD_URI_FALLBACK;
        const { contents } = await client.readResource({ uri });
        const first = contents[0];
        const text = first && "text" in first ? String(first.text) : "";
        if (cancelled) return;
        if (!text) {
          setHostState({ stage: "blocked", reason: "The build card came back empty. Run the app locally and try again." });
          return;
        }
        clientRef.current = client;
        setHtml(text);
        setHostState({ stage: "ready" });
      } catch {
        if (cancelled) return;
        // /api/mcp is 403 in hosted-demo mode (allowlist untouched by design).
        setHostState({ stage: "blocked", reason: HOSTED_NOTICE });
      }
    })();
    return () => {
      cancelled = true;
      clientRef.current = null;
      void client.close();
    };
  }, []);

  // One bridge per loaded card document. Rebuilt only when the html changes
  // (once per page in practice); later presentations reuse it.
  useEffect(() => {
    const frame = frameRef.current;
    const client = clientRef.current;
    if (!html || !frame?.contentWindow || !client) return;
    const target = frame.contentWindow;
    const bridge = new AppBridge(
      client,
      { name: "PCBuildSage voice host", version: "0" },
      { openLinks: {}, serverTools: {} }
    );
    bridgeRef.current = bridge;
    const flush = () => {
      for (const presentation of latestRef.current) {
        if (sentRef.current.has(presentation.key)) continue;
        sentRef.current.add(presentation.key);
        void bridge.sendToolResult(presentation.output as Parameters<AppBridge["sendToolResult"]>[0]);
      }
    };
    bridge.oninitialized = flush;
    bridge.onsizechange = ({ height: next }) => {
      if (typeof next === "number" && next > 0) setHeight(next);
    };
    bridge.onopenlink = async ({ url }) => {
      window.open(url, "_blank", "noopener");
      return {};
    };
    void bridge.connect(new PostMessageTransport(target, target));
    // A presentation already waiting (fast stub turn) flushes from
    // oninitialized, which fires once the card app connects.
    return () => {
      bridgeRef.current = null;
      void bridge.close();
    };
  }, [html]);

  // Presentations that arrive after the bridge initialized go out immediately.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || hostState.stage !== "ready") return;
    for (const presentation of presentations) {
      if (sentRef.current.has(presentation.key)) continue;
      sentRef.current.add(presentation.key);
      void bridge.sendToolResult(presentation.output as Parameters<AppBridge["sendToolResult"]>[0]);
    }
  }, [presentations, hostState.stage]);

  if (hostState.stage === "blocked") {
    return (
      <p
        className="rounded-card border border-border bg-surface px-4 py-3 text-sm text-text-secondary"
        role="note"
      >
        {hostState.reason}
      </p>
    );
  }

  if (!html) {
    return (
      <p className="px-1 py-2 text-sm text-text-muted" role="status">
        Preparing build card…
      </p>
    );
  }

  return (
    <iframe
      ref={frameRef}
      title="Proposed builds"
      sandbox="allow-scripts"
      srcDoc={html}
      style={{ width: "100%", height, border: 0 }}
    />
  );
}
