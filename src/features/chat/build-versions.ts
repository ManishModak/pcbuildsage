import { isToolPart } from "@/lib/message-parts";
import type { ToolPart } from "./tool-chip";
import type { ChatUIMessage } from "./message";
import {
  deriveBuildsFromToolParts,
  derivedBuildsFromValidation,
  enrichBuildsWithToolProducts,
  extractBuildsFromMessage,
  hasValidationSnapshot,
  isFinishedPresentPart,
  isPresentBuildPart,
  isValidatePart,
  TEXT_BUILD_CAVEAT,
  type DerivedBuild
} from "./build-derive";

export { isFinishedPresentPart, isPresentBuildPart, TEXT_BUILD_CAVEAT };

/** Version label for a turn that validated a build but never presented one. */
export const VALIDATED_VERSION_LABEL = "Validated — not presented yet";

export type BuildVersion = {
  /**
   * Stable identity for selection: message index plus what produced it.
   * Version *numbers* get renumbered when a chat is edited or truncated, so
   * the panel keys off this instead.
   */
  id: string;
  version: number;
  messageIndex: number;
  presentationId?: string;
  label: string;
  builds: DerivedBuild[];
};

export type BuildVersionOptions = {
  /**
   * Id of the assistant message being streamed right now, if any. A tool call
   * that is still streaming only counts as a build inside that one message;
   * without it, an unfinished call is treated as interrupted, which is what a
   * loaded or finished transcript wants.
   */
  streamingMessageId?: string;
};

/** The last finished `validate_build` call in a message that produced a snapshot. */
function latestValidatingPart(parts: ToolPart[]): ToolPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!isValidatePart(part) || part.state !== "output-available") continue;
    if (hasValidationSnapshot(part)) return part;
  }
  return undefined;
}

/**
 * Every assistant turn that validated a build without presenting one.
 *
 * All of them, not just the latest: a turn that has a real snapshot must never
 * be labelled as a build scraped out of prose, and the fallback below is gated
 * on exactly this. Several can be true at once in a long interrupted session,
 * which is why the version picker disambiguates a repeated label.
 */
function findValidatedOnlyMessageIndices(
  messages: ChatUIMessage[],
  streamingMessageId?: string
): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const parts = (Array.isArray(msg.parts) ? msg.parts : []).filter(isToolPart) as ToolPart[];
    if (parts.some((part) => isFinishedPresentPart(part, msg.id, streamingMessageId))) continue;
    if (latestValidatingPart(parts)) indices.add(i);
  }
  return indices;
}

/**
 * Scan assistant messages to find all distinct proposed build versions across
 * the chat session.
 *
 * A version comes from a finished `present_build`, or - for a turn that
 * validated but never presented - from the latest `validate_build` snapshot,
 * so a chat interrupted mid-stream still has a build to show.
 */
export function findAllBuildVersions(
  messages: ChatUIMessage[],
  currency: string,
  options: BuildVersionOptions = {}
): BuildVersion[] {
  const streamingMessageId = options.streamingMessageId;
  const validatedOnlyIndices = findValidatedOnlyMessageIndices(messages, streamingMessageId);

  const toolPartsUpTo: ToolPart[] = [];
  const versions: BuildVersion[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgParts = Array.isArray(msg.parts) ? msg.parts : [];

    if (msg.role !== "assistant") {
      toolPartsUpTo.push(...msgParts.filter(isToolPart));
      continue;
    }

    const assistantToolParts: ToolPart[] = [];
    const presentParts: ToolPart[] = [];

    for (const rawPart of msgParts) {
      if (isToolPart(rawPart)) {
        const part = rawPart as unknown as ToolPart;
        assistantToolParts.push(part);
        if (isFinishedPresentPart(part, msg.id, streamingMessageId)) {
          presentParts.push(part);
        }
      }
    }

    if (presentParts.length > 0) {
      for (const presentPart of presentParts) {
        const presentIndexInMsg = assistantToolParts.indexOf(presentPart);
        const partsUpToThisPresent = [
          ...toolPartsUpTo,
          ...assistantToolParts.slice(0, presentIndexInMsg + 1)
        ];

        const derived = deriveBuildsFromToolParts(partsUpToThisPresent, currency, presentPart);
        if (derived.length > 0) {
          const enriched = enrichBuildsWithToolProducts(derived, partsUpToThisPresent);
          const versionNum = versions.length + 1;
          versions.push({
            id: `${i}:present:${presentPart.toolCallId ?? versionNum}`,
            version: versionNum,
            messageIndex: i,
            presentationId: presentPart.toolCallId,
            label: `Version ${versionNum}`,
            builds: enriched
          });
        }
      }
      toolPartsUpTo.push(...assistantToolParts);
      continue;
    }

    toolPartsUpTo.push(...assistantToolParts);

    if (validatedOnlyIndices.has(i)) {
      const validatingPart = latestValidatingPart(assistantToolParts);
      const validated = validatingPart ? derivedBuildsFromValidation(validatingPart, currency) : [];
      if (validated.length > 0) {
        const versionNum = versions.length + 1;
        versions.push({
          id: `${i}:validated:${validatingPart?.toolCallId ?? versionNum}`,
          version: versionNum,
          messageIndex: i,
          label: VALIDATED_VERSION_LABEL,
          builds: validated
        });
        continue;
      }
    }

    const builds = extractBuildsFromMessage(msg, currency, toolPartsUpTo);
    if (builds.length > 0) {
      const versionNum = versions.length + 1;
      versions.push({
        id: `${i}:text:${versionNum}`,
        version: versionNum,
        messageIndex: i,
        // Parsed out of prose, not computed by the rules engine: it must never
        // be offered as an ordinary "Version N" proposal.
        label: TEXT_BUILD_CAVEAT,
        builds
      });
    }
  }

  return versions;
}

/**
 * The builds the panel was opened on - but only for the session on screen.
 *
 * ChatView is not remounted on a session switch, so whatever the panel was
 * showing would otherwise survive into the next chat. Scoping the stored builds
 * to the session they came from makes that impossible by construction, rather
 * than clearing it a frame later in an effect.
 */
export function openedBuildsForSession(
  opened: { sessionId: string; builds: DerivedBuild[] } | null | undefined,
  sessionId: string
): DerivedBuild[] | null {
  return opened && opened.sessionId === sessionId ? opened.builds : null;
}

/**
 * A value-based fingerprint of a build list.
 *
 * The derived builds are rebuilt from tool parts on every pass, so identity
 * comparisons say "changed" when nothing did. Anything that reacts to build
 * data - the header effect in particular - has to compare this instead, or it
 * re-arms itself forever: set state, re-render, derive fresh objects, re-arm.
 */
export function buildsFingerprint(builds: DerivedBuild[] | null | undefined): string {
  if (!builds || builds.length === 0) return "";
  return builds
    .map(
      (build) =>
        `${build.label || ""}:${build.currency}:${build.total ?? "?"}:${build.textDerived ? "t" : ""}:${
          build.validation ? "v" : ""
        }:${build.components
          .map((c) => `${c.category}:${c.name}:${c.price}:${c.currency}:${c.status ?? ""}`)
          .join(",")}`
    )
    .join("|");
}

/**
 * A value-based fingerprint of everything the chat header renders, so the
 * effect that publishes it only fires when the header would actually look
 * different.
 */
export function buildHeaderSignature(header: {
  sessionId: string;
  model: string;
  streaming: boolean;
  compacting: boolean;
  sidePanelOpen: boolean;
  messageCount: number;
  /**
   * Value fingerprint of the whole transcript, not just its length: the header
   * closes over the messages (the transcript menu copies and downloads them),
   * so a reply streaming in has to move this or the export goes out missing it.
   */
  transcript: string;
  error: string;
  currency: string;
  countryCode: string;
  buildPrice: string | null;
  builds: DerivedBuild[] | null | undefined;
}): string {
  return [
    header.sessionId,
    header.model,
    header.streaming ? "1" : "0",
    header.compacting ? "1" : "0",
    header.sidePanelOpen ? "1" : "0",
    header.messageCount,
    header.transcript,
    header.error,
    header.currency,
    header.countryCode,
    header.buildPrice ?? "",
    buildsFingerprint(header.builds)
  ].join("\u0001");
}

/**
 * Which version the panel should show.
 *
 * Nothing selected means the newest version, and so does a selection whose id
 * no longer exists - an edit or a truncation can renumber or drop the version
 * the user was looking at, and the panel must still show a real build instead
 * of an empty card.
 */
export function resolveSelectedVersion(
  versions: BuildVersion[],
  selectedVersionId?: string
): BuildVersion | undefined {
  if (versions.length === 0) return undefined;
  const selected = selectedVersionId ? versions.find((v) => v.id === selectedVersionId) : undefined;
  return selected ?? versions[versions.length - 1];
}

/**
 * The selection to move to when the version list changed.
 *
 * A version that just arrived supersedes whatever was selected, so the panel
 * follows the new build rather than staying pinned to an older one. Returns
 * the current selection unchanged when the newest version is still the same
 * one, which is what keeps this from re-selecting on every render.
 */
export function followNewestVersion(
  selectedVersionId: string | undefined,
  previousLatestId: string | undefined,
  versions: BuildVersion[]
): string | undefined {
  const newestId = versions.length > 0 ? versions[versions.length - 1].id : undefined;
  if (!newestId) return selectedVersionId;
  if (previousLatestId === newestId) return selectedVersionId;
  return newestId;
}

export function findVersionByPresentationId(
  versions: BuildVersion[],
  presentationId: string
): BuildVersion | undefined {
  return versions.find((v) => v.presentationId === presentationId);
}

export function findVersionById(versions: BuildVersion[], id: string): BuildVersion | undefined {
  return versions.find((v) => v.id === id);
}

export function findVersionByNumber(
  versions: BuildVersion[],
  versionNum: number
): BuildVersion | undefined {
  return versions.find((v) => v.version === versionNum);
}
