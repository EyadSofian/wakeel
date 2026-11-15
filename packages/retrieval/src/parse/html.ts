import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import { scoreQuality } from "./quality";
import type { ParsedDocument } from "./types";

/**
 * Web pages and uploaded HTML (architecture §8.1): Readability keeps the article and drops
 * navigation, footers and ads, then Turndown writes Markdown with headings and GFM tables.
 * Runs in the worker; scripts in the page are never executed (linkedom has no script engine).
 */
export function parseHtml(html: string, options: { url?: string } = {}): ParsedDocument {
  const { document } = parseHTML(html);
  const pageTitle = document.querySelector("title")?.textContent?.trim() || null;
  // Readability mutates the document; it keeps <table> content and heading levels.
  // linkedom's document is DOM-shaped; Readability's type names the browser's Document.
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], {
    charThreshold: 100,
  }).parse();
  // No article (a fragment, a list page): keep the whole input. Readability has mutated `document`,
  // so fall back to the original string; Turndown still drops scripts, styles and forms.
  const content = article?.content ?? html;
  const title = article?.title?.trim() || pageTitle;
  // Readability demotes the article's own <h1> to <h2>; restore it as the one top-level heading.
  const body = toMarkdown(content).replace(/^#{1,6}\s+(.+)\n*/, (line, text: string) =>
    title && text.trim() === title ? "" : line,
  );
  const markdown = title ? `# ${title}\n\n${body}` : body;
  const text = markdown;
  const chars = [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  void options.url;
  return {
    title,
    markdown,
    pages: [{ number: 1, chars, ocr: false }],
    via: "readability",
    quality: scoreQuality({ text, pageChars: [chars] }),
  };
}

function toMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use(tables);
  td.remove(["script", "style", "noscript", "iframe", "form"]);
  // Readability wraps content in divs and may keep empty anchors; collapse runs of blank lines.
  return td
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
