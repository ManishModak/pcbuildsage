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
  type DerivedBuild
} from "./build-derive";

export { isFinishedPresentPart, isPresentBuildPart };

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

/**
 * Filter and extract the present_build tool parts of a message that finished
 * presenting a build.
 */
export function extractPresentToolParts(
  parts: unknown[],
  options: BuildVersionOptions & { messageId?: string } = {}
): ToolPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.filter(
    (part): part is ToolPart =>
      isToolPart(part) &&
      isFinishedPresentPart(part as unknown as ToolPart, options.messageId, options.streamingMessageId)
  );
}

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
 * Index of the last assistant turn that validated a build without presenting
 * one, or -1. Only the latest such turn becomes a version: earlier ones are
 * superseded, and the version label is a fixed string, so two of them would
 * be indistinguishable in the version picker.
 */
function findValidatedOnlyMessageIndex(messages: ChatUIMessage[], streamingMessageId?: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const parts = (Array.isArray(msg.parts) ? msg.parts : []).filter(isToolPart) as ToolPart[];
    if (parts.some((part) => isFinishedPresentPart(part, msg.id, streamingMessageId))) continue;
    if (latestValidatingPart(parts)) return i;
  }
  return -1;
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
  const validatedOnlyIndex = findValidatedOnlyMessageIndex(messages, streamingMessageId);

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

    if (i === validatedOnlyIndex) {
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
        label: `Version ${versionNum}`,
        builds
      });
    }
  }

  return versions;
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
