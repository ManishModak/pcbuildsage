/**
 * src/features/alexa/present-cards.ts
 *
 * Pure extraction of `present_build` tool outputs from UI messages
 * (contract §3). The page reads cards from
 * `part.output.structuredContent.cards`, falling back to
 * `JSON.parse(part.output.content[0].text).cards`. A failed present
 * (`presented === false`) yields no cards: it renders as text, never a card.
 */

export interface PresentCard {
  label: string;
  notes?: string;
  snapshot: {
    components?: Array<{
      category: string;
      name: string;
      price: number | null;
      currency: string;
      retailer?: string;
      url?: string;
      included?: boolean;
    }>;
    total?: number | null;
    currency?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PresentedBuild {
  /** Stable key for React + for tracking what the card host already sent. */
  key: string;
  toolCallId?: string;
  cards: PresentCard[];
  /** The full MCP CallToolResult (contract §3 output), sent to the card app. */
  output: unknown;
}

interface ToolPartLike {
  type: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
}

interface MessageLike {
  id?: string;
  role?: string;
  parts?: unknown;
}

function toolNameOf(part: ToolPartLike): string {
  if (typeof part.toolName === "string" && part.toolName.length > 0) return part.toolName;
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

function isToolPartLike(part: unknown): part is ToolPartLike {
  if (typeof part !== "object" || part === null) return false;
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("tool-");
}

function readCards(output: unknown): { presented: boolean; cards: PresentCard[] } | null {
  if (typeof output !== "object" || output === null) return null;
  const out = output as {
    structuredContent?: { presented?: unknown; cards?: unknown };
    content?: unknown;
  };
  let scoped = out.structuredContent;
  if ((!scoped || !Array.isArray(scoped.cards)) && Array.isArray(out.content)) {
    const first = out.content[0] as { text?: unknown } | undefined;
    if (first && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text) as {
          presented?: unknown;
          cards?: unknown;
        };
        if (parsed && typeof parsed === "object") scoped = parsed;
      } catch {
        return null;
      }
    }
  }
  if (!scoped || !Array.isArray(scoped.cards)) return null;
  // presented === false (or missing) is a failed present: text, never a card.
  if (scoped.presented !== true) return { presented: false, cards: [] };
  return { presented: true, cards: scoped.cards as PresentCard[] };
}

/**
 * All successfully presented builds in message order. Parts for other tools,
 * running calls (no output yet), and failed presents are skipped.
 */
export function extractPresentedBuilds(messages: MessageLike[]): PresentedBuild[] {
  const found: PresentedBuild[] = [];
  for (const message of messages) {
    if (!message || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isToolPartLike(part)) continue;
      if (toolNameOf(part) !== "present_build") continue;
      if (part.output == null) continue;
      const read = readCards(part.output);
      if (!read || !read.presented || read.cards.length === 0) continue;
      const key = `${message.id ?? "msg"}:${part.toolCallId ?? found.length}`;
      found.push({ key, toolCallId: part.toolCallId, cards: read.cards, output: part.output });
    }
  }
  return found;
}

/** True when any present_build part (successful or failed) has landed. */
export function hasPresentAttempt(messages: MessageLike[]): boolean {
  for (const message of messages) {
    if (!message || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (isToolPartLike(part) && toolNameOf(part) === "present_build") return true;
    }
  }
  return false;
}
