import { Fragment, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";

// A minimal, safe markdown renderer — enough for the sage's replies (paragraphs,
// lists, fenced code, inline code, bold). No HTML injection, no dependency.
// Streaming text renders plainly, without per-character gimmicks.
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^[\s|:-]+$/.test(trimmed);
}

// A cell that is only a price or a number ("₹45,999", "Rs. 1,20,000", "38"):
// columns made of these right-align in mono so the digits line up.
const NUMERIC_CELL = /^(?:[₹$€£]|rs\.?|inr)?\s*[\d][\d,.]*\s*(?:\/-|k|lakh)?$/i;

function renderTable(lines: string[], key: number, renderInlineFn: (text: string) => ReactNode) {
  const parseRow = (line: string): string[] => {
    const parts = line.split("|");
    if (parts[0]?.trim() === "") parts.shift();
    if (parts[parts.length - 1]?.trim() === "") parts.pop();
    return parts.map((cell) => cell.trim());
  };

  const headers = parseRow(lines[0] || "");
  const rows = lines.slice(2).map((line) => parseRow(line));
  // A column is numeric when every filled cell in it looks like a price or number.
  const numericColumns = headers.map((_, col) => {
    const cells = rows.map((row) => row[col] ?? "").filter((cell) => cell !== "");
    return cells.length > 0 && cells.every((cell) => NUMERIC_CELL.test(cell.replace(/\*\*/g, "")));
  });

  return (
    <div key={key} className="my-2 overflow-x-auto rounded-card border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-raised text-caption text-text-secondary">
            {headers.map((header, idx) => (
              <th
                key={idx}
                className={cn("type-label px-4 py-2.5", numericColumns[idx] ? "text-right" : "text-left")}
              >
                {renderInlineFn(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {row.map((cell, cellIdx) => (
                <td
                  key={cellIdx}
                  className={cn("px-4 py-2.5 text-text", numericColumns[cellIdx] && "text-right font-mono tabular-nums")}
                >
                  {renderInlineFn(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `streaming` puts a cycling rune caret after the last block while a reply arrives. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseBlocks(text);
  return (
    <div className={cn("flex flex-col gap-4 text-base leading-[1.65] text-text", streaming && "rune-caret")}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-card border border-border bg-surface-raised p-3.5 font-mono text-sm leading-relaxed text-text"
            >
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="ml-5 list-disc space-y-1.5 marker:text-text-muted">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ordered-list") {
          return (
            <ol key={index} className="ml-5 list-decimal space-y-1.5 marker:text-text-muted">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "blockquote") {
          return (
            <blockquote key={index} className="border-l-2 border-border pl-4 text-text-secondary">
              {renderInline(block.content)}
            </blockquote>
          );
        }
        if (block.type === "hr") {
          return <hr key={index} className="my-2 border-t border-border" />;
        }
        if (block.type === "heading") {
          const Tag = `h${Math.min(6, Math.max(1, block.level))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
          const classes =
            block.level === 1
              ? "type-title mt-3 text-xl text-text"
              : block.level === 2
                ? "type-title mt-2 text-lg text-text"
                : "type-title mt-1 text-base text-text";
          return (
            <Tag key={index} className={classes}>
              {renderInline(block.content)}
            </Tag>
          );
        }
        if (block.type === "table") {
          return renderTable(block.lines, index, renderInline);
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
  | { type: "list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "blockquote"; content: string }
  | { type: "hr" }
  | { type: "table"; lines: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let paragraph: string[] = [];
  let list: string[] = [];
  let orderedList: string[] = [];

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
  const flushOrderedList = () => {
    if (orderedList.length) {
      blocks.push({ type: "ordered-list", items: orderedList });
      orderedList = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushOrderedList();
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      flushAll();
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
      flushAll();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2]
      });
      i += 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "table", lines: tableLines });
      continue;
    }
    if (line.trim() === "---" || line.trim() === "***" || line.trim() === "___") {
      flushAll();
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    if (line.trim().startsWith(">")) {
      flushAll();
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", content: quoteLines.join(" ") });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      flushOrderedList();
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      i += 1;
      continue;
    }
    const orderedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushList();
      orderedList.push(orderedMatch[1]);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      flushAll();
      i += 1;
      continue;
    }
    flushList();
    flushOrderedList();
    paragraph.push(line);
    i += 1;
  }
  flushAll();
  return blocks;
}

// Inline: ***bold-italic***, **bold**, *italic*, _italic_, `code`, and [links](url).
function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>);
    const token = match[0];
    if (token.startsWith("***")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-text">
          <em className="italic">{token.slice(3, -3)}</em>
        </strong>
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-text">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key++} className="italic text-text">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("_")) {
      nodes.push(
        <em key={key++} className="italic text-text">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key++} className="rounded-chip bg-surface-raised px-1.5 py-0.5 font-mono text-[0.875em] text-text">
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
          className="text-accent underline underline-offset-2 transition-colors duration-150 hover:text-text"
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
