import { Fragment, type ReactNode } from "react";

/**
 * Small, dependency-free Markdown renderer.
 * Output is built exclusively from React elements (no dangerouslySetInnerHTML), raw HTML in the source
 * is shown as plain text, images are rendered as links, and only http(s) link targets are kept.
 */

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; lines: string[] }
  | { type: "list"; items: ListItem[]; ordered: boolean }
  | { type: "table"; head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][] }
  | { type: "hr" };
type ListItem = { text: string; checked?: boolean; rest: Block[] };

const MAX_DEPTH = 4;
const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const listMarker = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableSeparator = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function safeLinkHref(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function splitRow(line: string) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function startsBlock(line: string, next?: string) {
  return fence.test(line) || heading.test(line) || rule.test(line) || /^\s{0,3}>/.test(line) || listMarker.test(line)
    || Boolean(next && line.includes("|") && tableSeparator.test(next) && next.includes("-"));
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fenced = fence.exec(line);
    if (fenced) {
      const marker = fenced[1];
      const body: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) body.push(lines[index++]);
      index++;
      blocks.push({ type: "code", lang: fenced[2], text: body.join("\n") });
      continue;
    }
    const head = heading.exec(line);
    if (head) { blocks.push({ type: "heading", level: head[1].length, text: head[2] }); index++; continue; }
    if (rule.test(line)) { blocks.push({ type: "hr" }); index++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ type: "quote", lines: quoted });
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && tableSeparator.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      const headCells = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" as const : cell.endsWith(":") ? "right" as const : cell.startsWith(":") ? "left" as const : undefined);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) rows.push(splitRow(lines[index++]));
      blocks.push({ type: "table", head: headCells, align, rows });
      continue;
    }
    const marker = listMarker.exec(line);
    if (marker) {
      const baseIndent = marker[1].length;
      const ordered = /\d/.test(marker[2]);
      const items: ListItem[] = [];
      while (index < lines.length) {
        const current = listMarker.exec(lines[index]);
        if (!current || current[1].length !== baseIndent || /\d/.test(current[2]) !== ordered) break;
        let text = current[3];
        let checked: boolean | undefined;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) { checked = task[1] !== " "; text = task[2]; }
        index++;
        const nested: string[] = [];
        while (index < lines.length) {
          const next = lines[index];
          const nextMarker = listMarker.exec(next);
          if (nextMarker && nextMarker[1].length <= baseIndent) break;
          if (!next.trim()) {
            const after = lines[index + 1];
            if (after !== undefined && after.trim() && /^\s{2,}\S/.test(after) && (after.length - after.trimStart().length) > baseIndent) { nested.push(next); index++; continue; }
            break;
          }
          if (nextMarker || (next.length - next.trimStart().length) > baseIndent) { nested.push(next.slice(Math.min(baseIndent + 2, next.length - next.trimStart().length))); index++; continue; }
          break;
        }
        const children = nested.length ? parseBlocks(nested.join("\n")) : [];
        const continuation = children[0]?.type === "paragraph" ? children.shift() as Extract<Block, { type: "paragraph" }> : null;
        items.push({ text: continuation ? `${text} ${continuation.text}` : text, checked, rest: children });
      }
      blocks.push({ type: "list", items, ordered });
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], lines[index + 1])) paragraph.push(lines[index++]);
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

const inlinePattern = /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|_([^\s_][\s\S]*?)_|<(https?:\/\/[^>\s]+)>/g;

function renderInline(text: string, depth = 0, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let count = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const parts = value.split(/ {2,}\n|\\\n/);
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) nodes.push(<br key={`${keyPrefix}-br-${count++}`} />);
      nodes.push(part.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1"));
    });
  };
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index ?? 0;
    // Intra-word underscores (snake_case) are not emphasis.
    if (match[9] !== undefined && (/\w/.test(text[start - 1] ?? "") || /\w/.test(text[start + match[0].length] ?? ""))) continue;
    if (start < last) continue;
    pushText(text.slice(last, start));
    last = start + match[0].length;
    const key = `${keyPrefix}-${count++}`;
    const nested = (value: string) => depth < MAX_DEPTH ? renderInline(value, depth + 1, key) : [value];
    if (match[1]) {
      nodes.push(<code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-slate-800">{match[2].trim()}</code>);
    } else if (match[4] !== undefined) {
      const isImage = match[0].startsWith("!");
      const href = safeLinkHref(match[4]);
      const label = match[3] || match[4];
      if (!href) nodes.push(<Fragment key={key}>{isImage ? `[图片：${label}]` : nested(label)}</Fragment>);
      else nodes.push(<a key={key} className="gp-link" href={href} target="_blank" rel="noopener noreferrer nofollow">{isImage ? `[图片：${label}]` : nested(label)}</a>);
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(<strong key={key} className="font-semibold">{nested(match[5] ?? match[6])}</strong>);
    } else if (match[7] !== undefined) {
      nodes.push(<del key={key}>{nested(match[7])}</del>);
    } else if (match[8] !== undefined || match[9] !== undefined) {
      nodes.push(<em key={key}>{nested(match[8] ?? match[9])}</em>);
    } else if (match[10]) {
      const href = safeLinkHref(match[10]);
      nodes.push(href ? <a key={key} className="gp-link" href={href} target="_blank" rel="noopener noreferrer nofollow">{match[10]}</a> : match[10]);
    }
  }
  pushText(text.slice(last));
  return nodes;
}

const headingClass = [
  "",
  "mt-6 mb-3 border-b border-slate-200 pb-2 text-2xl font-bold text-slate-900",
  "mt-6 mb-2 border-b border-slate-100 pb-1.5 text-xl font-semibold text-slate-900",
  "mt-5 mb-2 text-lg font-semibold text-slate-900",
  "mt-4 mb-1.5 text-base font-semibold text-slate-900",
  "mt-4 mb-1.5 text-sm font-semibold text-slate-900",
  "mt-4 mb-1.5 text-sm font-semibold text-slate-600",
];

function renderBlocks(blocks: Block[], depth: number, keyPrefix: string): ReactNode {
  return blocks.map((block, blockIndex) => {
    const key = `${keyPrefix}-${blockIndex}`;
    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as "h1";
        return <Tag key={key} className={headingClass[block.level]}>{renderInline(block.text, 0, key)}</Tag>;
      }
      case "paragraph":
        return <p key={key} className="my-3 leading-7 text-slate-800">{renderInline(block.text, 0, key)}</p>;
      case "code":
        return <pre key={key} className="my-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-[13px] leading-6 text-slate-800" data-lang={block.lang || undefined}><code className="font-mono">{block.text}</code></pre>;
      case "quote":
        return <blockquote key={key} className="my-3 border-l-4 border-slate-300 bg-slate-50/70 py-1 pl-4 text-slate-600">{depth < MAX_DEPTH ? renderBlocks(parseBlocks(block.lines.join("\n")), depth + 1, key) : block.lines.join("\n")}</blockquote>;
      case "hr":
        return <hr key={key} className="my-5 border-slate-200" />;
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return <Tag key={key} className={`my-3 space-y-1 pl-6 leading-7 text-slate-800 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, itemIndex) => {
            const itemKey = `${key}-${itemIndex}`;
            return <li key={itemKey} className={item.checked !== undefined ? "list-none -ml-5" : undefined}>
              {item.checked !== undefined && <span aria-hidden="true" className="mr-1.5">{item.checked ? "☑" : "☐"}</span>}
              {item.checked !== undefined && <span className="sr-only">{item.checked ? "已完成：" : "未完成："}</span>}
              {renderInline(item.text, 0, itemKey)}
              {item.rest.length > 0 && depth < MAX_DEPTH && renderBlocks(item.rest, depth + 1, itemKey)}
            </li>;
          })}
        </Tag>;
      }
      case "table":
        return <div key={key} className="my-3 overflow-x-auto"><table className="min-w-full border-collapse text-sm">
          <thead><tr>{block.head.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: block.align[cellIndex] }} className="border border-slate-200 bg-slate-50 px-3 py-1.5 font-semibold text-slate-800">{renderInline(cell, 0, `${key}-h${cellIndex}`)}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.head.map((_, cellIndex) => <td key={cellIndex} style={{ textAlign: block.align[cellIndex] }} className="border border-slate-200 px-3 py-1.5 text-slate-700">{renderInline(row[cellIndex] ?? "", 0, `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
        </table></div>;
    }
  });
}

export function MarkdownPreview({ source }: { source: string }) {
  return <div className="gp-markdown break-words text-sm" data-testid="markdown-preview">{renderBlocks(parseBlocks(source), 0, "b")}</div>;
}
