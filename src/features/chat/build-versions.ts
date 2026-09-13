import { isToolPart } from "@/lib/message-parts";
import type { ToolPart } from "./tool-chip";
import type { ChatUIMessage } from "./message";
import {
  deriveBuildsFromToolParts,
  enrichBuildsWithToolProducts,
  extractBuildsFromMessage,
  type DerivedBuild
} from "./build-derive";

export type BuildVersion = {
  version: number;
  messageIndex: number;
  presentationId?: string;
  label: string;
  builds: DerivedBuild[];
};

/**
 * Filter and extract valid present_build tool parts from a list of tool parts.
 */
export function extractPresentToolParts(parts: unknown[]): ToolPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.filter(
    (part): part is ToolPart =>
      isToolPart(part) &&
      (part.type === "tool-present_build" || (part as ToolPart).toolName === "present_build") &&
      (part.state === "output-available" ||
        part.state === "input-available" ||
        Boolean((part as ToolPart).input))
  );
}

/**
 * Scan assistant messages to find all distinct proposed build versions across the chat session.
 */
export function findAllBuildVersions(
  messages: ChatUIMessage[],
  currency: string
): BuildVersion[] {
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
        if (
          (part.type === "tool-present_build" || part.toolName === "present_build") &&
          (part.state === "output-available" || part.state === "input-available" || Boolean(part.input))
        ) {
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
            version: versionNum,
            messageIndex: i,
            presentationId: presentPart.toolCallId,
            label: `Version ${versionNum}`,
            builds: enriched
          });
        }
      }
      toolPartsUpTo.push(...assistantToolParts);
    } else {
      toolPartsUpTo.push(...assistantToolParts);
      const builds = extractBuildsFromMessage(msg, currency, toolPartsUpTo);
      if (builds.length > 0) {
        const versionNum = versions.length + 1;
        versions.push({
          version: versionNum,
          messageIndex: i,
          label: `Version ${versionNum}`,
          builds
        });
      }
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

export function findVersionByNumber(
  versions: BuildVersion[],
  versionNum: number
): BuildVersion | undefined {
  return versions.find((v) => v.version === versionNum);
}
