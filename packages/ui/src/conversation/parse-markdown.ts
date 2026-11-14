/**
 * The markdown subset bot text may use (message.ts `format: "markdown"`): paragraphs, line breaks,
 * `-`/`*` and `1.` lists, **bold**, *italic* or _italic_, `code`, [links](https://…) and bare URLs.
 * It parses to a small tree that `Markdown.tsx` renders as React elements, so nothing is ever set
 * as HTML (CLAUDE.md §6) and markup in the text stays text. Links are kept only for http, https,
 * mailto and tel; anything else stays as the characters that were written.
 */
export type MdInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "strong"; c: MdInline[] }
  | { t: "em"; c: MdInline[] }
  | { t: "link"; href: string; c: MdInline[] };

export type MdBlock = { t: "p"; c: MdInline[] } | { t: "ul"; items: MdInline[][] } | { t: "ol"; items: MdInline[][] };

const BULLET = /^[-*] +/;
const NUMBERED = /^\d{1,3}[.)] +/;
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)/i;
/** A bare URL: up to whitespace, minus trailing punctuation that usually ends a sentence. */
const BARE_URL = /^https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]،؛؟]/;

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const chunk of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = chunk.split("\n");
    if (lines.every((l) => BULLET.test(l)))
      blocks.push({ t: "ul", items: lines.map((l) => inline(l.replace(BULLET, ""))) });
    else if (lines.every((l) => NUMBERED.test(l)))
      blocks.push({ t: "ol", items: lines.map((l) => inline(l.replace(NUMBERED, ""))) });
    else if (chunk.length > 0) blocks.push({ t: "p", c: inline(chunk) });
  }
  return blocks;
}

function inline(source: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = source[i] as string;
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const end = source.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: inline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && source[i + 1] !== ch && source[i + 1] !== " ") {
      const end = source.indexOf(ch, i + 1);
      if (end > i + 1 && source[end - 1] !== " ") {
        flush();
        out.push({ t: "em", c: inline(source.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link && SAFE_HREF.test(link[2] as string)) {
        flush();
        out.push({ t: "link", href: link[2] as string, c: inline(link[1] as string) });
        i += link[0].length;
        continue;
      }
      if (link) {
        // An unsafe scheme: keep the whole thing as written, so no part of it becomes a link.
        text += link[0];
        i += link[0].length;
        continue;
      }
    }
    if (ch === "h") {
      const url = BARE_URL.exec(rest);
      if (url) {
        flush();
        out.push({ t: "link", href: url[0], c: [{ t: "text", v: url[0] }] });
        i += url[0].length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}
