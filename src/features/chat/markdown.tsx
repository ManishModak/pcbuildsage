import { Fragment, memo, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { RuneSpace, runeFor } from "@/components/app/rune-text";

// A minimal, safe markdown renderer — enough for the sage's replies (paragraphs,
// lists, fenced code, inline code, bold). No HTML injection, no dependency.
// While a reply streams, its newest letters arrive as runes (see Markdown).

// How many of the newest blocks keep per-letter rune spans while streaming.
// Two, so a block's last letters finish settling after the next block starts.
const RUNE_BLOCKS = 2;
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^[\s|:-]+$/.test(trimmed);
}

// A cell that is only a price or a number ("₹45,999", "Rs. 1,20,000", "38"):
// columns made of these right-align in mono so the digits line up.
const NUMERIC_CELL = /^(?:[₹$€£]|rs\.?|inr)?\s*[\d][\d,.]*\s*(?:\/-|k|lakh)?$/i;

function renderTable(lines: string[], renderInlineFn: (text: string) => ReactNode) {
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
    <div className="my-2 overflow-x-auto rounded-card border border-border">
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

/**
 * `streaming` marks the reply arriving now: each new letter of its newest
 * blocks shows as a rune that settles into the letter (CSS only, .rune-stream
 * in globals.css), and a cycling rune caret sits after the last block. Older
 * blocks and finished replies are plain text.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseBlocks(text);
  const runesFrom = streaming ? blocks.length - RUNE_BLOCKS : blocks.length;
  return (
    <div className={cn("flex flex-col gap-4 text-base leading-[1.65] text-text", streaming && "rune-caret")}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} runes={index >= runesFrom} />
      ))}
    </div>
  );
}

// One block, skipped when its content hasn't changed: while a reply streams,
// only the block still growing re-renders.
const BlockView = memo(
  function BlockView({ block, runes }: { block: Block; runes: boolean }) {
    const renderInline = (text: string) => renderInlineText(text, runes);
    if (block.type === "code") {
      return (
        <pre className="overflow-x-auto rounded-card border border-border bg-surface-raised p-3.5 font-mono text-sm leading-relaxed text-text">
          <code>{block.content}</code>
        </pre>
      );
    }
    if (block.type === "list" || block.type === "ordered-list") {
      const List = block.type === "list" ? "ul" : "ol";
      return (
        <List
          className={cn(
            "ml-5 space-y-1.5 marker:text-text-muted",
            block.type === "list" ? "list-disc" : "list-decimal"
          )}
        >
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </List>
      );
    }
    if (block.type === "blockquote") {
      return <blockquote className="border-l-2 border-border pl-4 text-text-secondary">{renderInline(block.content)}</blockquote>;
    }
    if (block.type === "hr") {
      return <hr className="my-2 border-t border-border" />;
    }
    if (block.type === "heading") {
      const Tag = `h${Math.min(6, Math.max(1, block.level))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const classes =
        block.level === 1
          ? "type-title mt-3 text-xl text-text"
          : block.level === 2
            ? "type-title mt-2 text-lg text-text"
            : "type-title mt-1 text-base text-text";
      return <Tag className={classes}>{renderInline(block.content)}</Tag>;
    }
    if (block.type === "table") {
      return renderTable(block.lines, renderInline);
    }
    return <p>{renderInline(block.content)}</p>;
  },
  (prev, next) => prev.runes === next.runes && JSON.stringify(prev.block) === JSON.stringify(next.block)
);

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

// One span per letter for a streaming reply, keyed by its place in its text
// run: as more text arrives the earlier letters keep their spans, so their
// rune animation plays once, when the letter first appears. A run of spaces
// becomes one RuneSpace, as HTML would collapse it.
function runeLetters(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  Array.from(text).forEach((char, i, chars) => {
    if (!/\s/.test(char)) {
      nodes.push(
        <span key={i} className="rune-ch rune-stream" data-rune={runeFor(char, i)}>
          {char}
        </span>
      );
    } else if (i === 0 || !/\s/.test(chars[i - 1])) {
      nodes.push(<RuneSpace key={i} />);
    }
  });
  return nodes;
}

// Inline: ***bold-italic***, **bold**, *italic*, _italic_, `code`, and [links](url).
// `runes` turns the words (not code) into rune letters while a reply streams.
function renderInlineText(text: string, runes = false): ReactNode {
  const words = (value: string): ReactNode => (runes ? runeLetters(value) : value);
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(<Fragment key={key++}>{words(text.slice(lastIndex, match.index))}</Fragment>);
    const token = match[0];
    if (token.startsWith("***")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-text">
          <em className="italic">{words(token.slice(3, -3))}</em>
        </strong>
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-text">
          {words(token.slice(2, -2))}
        </strong>
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key++} className="italic text-text">
          {words(token.slice(1, -1))}
        </em>
      );
    } else if (token.startsWith("_")) {
      nodes.push(
        <em key={key++} className="italic text-text">
          {words(token.slice(1, -1))}
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
          {words(label)}
        </a>
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(<Fragment key={key++}>{words(text.slice(lastIndex))}</Fragment>);
  return nodes;
}
