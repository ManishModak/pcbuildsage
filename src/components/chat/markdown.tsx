import { Fragment, type ReactNode } from "react";

// A minimal, safe markdown renderer — enough for the sage's replies (paragraphs,
// lists, fenced code, inline code, bold). No HTML injection, no dependency.
// Streaming text renders plainly, without per-character gimmicks.
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^[\s|:-]+$/.test(trimmed);
}

function renderTable(lines: string[], key: number, renderInlineFn: (text: string) => ReactNode) {
  const parseRow = (line: string): string[] => {
    const parts = line.split("|");
    if (parts[0]?.trim() === "") parts.shift();
    if (parts[parts.length - 1]?.trim() === "") parts.pop();
    return parts.map((cell) => cell.trim());
  };

  const headers = parseRow(lines[0] || "");
  const rows = lines.slice(2).map((line) => parseRow(line));

  return (
    <div key={key} className="my-3 overflow-x-auto rounded-card border border-border bg-surface-raised/30 shadow-xs">
      <table className="w-full text-left border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-muted/50 font-medium text-text-secondary select-none">
            {headers.map((header, idx) => (
              <th key={idx} className="px-4 py-2.5 font-semibold">
                {renderInlineFn(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className="border-b border-border/40 hover:bg-surface-raised/50 transition-colors last:border-none"
            >
              {row.map((cell, cellIdx) => (
                <td key={cellIdx} className="px-4 py-3 text-text">
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
        if (block.type === "ordered-list") {
          return (
            <ol key={index} className="ml-5 list-decimal space-y-1 marker:text-text-muted">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "blockquote") {
          return (
            <blockquote key={index} className="border-l-4 border-warn/45 pl-3.5 italic text-text-secondary my-1.5 py-0.5">
              {renderInline(block.content)}
            </blockquote>
          );
        }
        if (block.type === "hr") {
          return <hr key={index} className="border-t border-border/60 my-4" />;
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
