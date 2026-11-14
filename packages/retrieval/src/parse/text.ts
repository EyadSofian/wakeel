import { scoreQuality } from "./quality";
import type { ParsedDocument } from "./types";

/** Plain text, Markdown and CSV need no parser service: they are already text (ADR-040 §2). */
export function parseText(
  body: string,
  mime: "text/plain" | "text/markdown" | "text/csv",
  name: string,
): ParsedDocument {
  const clean = (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body).replace(/\r\n?/g, "\n");
  const markdown = mime === "text/csv" ? csvToMarkdown(clean) : clean.trim();
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const chars = [...markdown].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  return {
    title: heading ?? name.replace(/\.[^.]+$/, ""),
    markdown,
    pages: [{ number: 1, chars, ocr: false }],
    via: "text",
    quality: scoreQuality({ text: markdown, pageChars: [chars] }),
  };
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** A CSV becomes one GFM table, which the chunker keeps atomic per row group (8.4). */
function csvToMarkdown(text: string): string {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  return [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}
