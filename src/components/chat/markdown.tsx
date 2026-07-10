import { Fragment, type ReactNode } from "react";

// A minimal, safe markdown renderer — enough for the sage's replies (paragraphs,
// lists, fenced code, inline code, bold). No HTML injection, no dependency.
// Streaming text renders plainly, without per-character gimmicks.
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="flex flex-col gap-3 text-base leading-relaxed text-text">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-chip border border-border bg-bg p-3 font-mono text-caption text-text-secondary"
            >
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="ml-5 list-disc space-y-1 marker:text-text-muted">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "heading") {
          const Tag = `h${Math.min(6, Math.max(1, block.level))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
          const classes =
            block.level === 1
              ? "text-2xl font-bold text-text mt-4 mb-2"
              : block.level === 2
                ? "text-xl font-bold text-text mt-3 mb-1.5"
                : "text-lg font-semibold text-text mt-2 mb-1";
          return (
            <Tag key={index} className={classes}>
              {renderInline(block.content)}
            </Tag>
          );
        }
        return <p key={index}>{renderInline(block.content)}</p>;
      })}
    </div>
  );
}

type Block =
  | { type: "paragraph"; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "code"; content: string }
  | { type: "list"; items: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", content: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", content: code.join("\n") });
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2]
      });
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }
    flushList();
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  flushList();
  return blocks;
}

// Inline: **bold**, `code`, and [links](url). Prices/model numbers in backticks read as mono.
function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>);
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-text">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key++} className="rounded bg-surface-raised px-1 py-0.5 font-mono text-[0.9em] text-text">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const closingBracket = token.indexOf("]");
      const label = token.slice(1, closingBracket);
      const url = token.slice(closingBracket + 2, -1);
      const hasUnsafeProtocol = /^(?:javascript|data|vbscript):/i.test(url.trim());
      const safeUrl = hasUnsafeProtocol ? "#" : url;
      nodes.push(
        <a
          key={key++}
          href={safeUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline transition-opacity hover:opacity-80"
        >
          {label}
        </a>
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  return nodes;
}
