/**
 * The structure-aware chunker (architecture §8.1 "Chunk", ADR-007 §5). Splits parsed Markdown on
 * headings, keeps tables whole (a table too big for one chunk is split by rows with its header
 * repeated), targets 350 tokens with a 500 maximum, and overlaps 15% between neighbours within a
 * section. Every chunk records its heading path; the embedded string is the path, a newline, the text.
 */

export interface Chunk {
  ordinal: number;
  headingPath: string[];
  text: string;
  tokenCount: number;
  /** "table" chunks hold one table (or a run of its rows); "text" chunks hold prose and lists. */
  kind: "text" | "table";
}

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  overlap: number;
}

export const CHUNK_DEFAULTS: ChunkOptions = { targetTokens: 350, maxTokens: 500, overlap: 0.15 };

const ARABIC = /\p{Script=Arabic}/u;

/**
 * Token estimate without a tokenizer: the embedding models differ, and an exact count per model is
 * not worth a dependency. Arabic splits into more tokens per character than Latin text in every
 * multilingual tokenizer we use, so it is counted at 2.5 characters per token against 4 for the rest.
 * It errs high, which keeps chunks under the model's limit.
 */
export function estimateTokens(text: string): number {
  let arabic = 0;
  let other = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    if (ARABIC.test(ch)) arabic++;
    else other++;
  }
  return Math.ceil(arabic / 2.5 + other / 4 + countWords(text) * 0.25);
}

const countWords = (s: string) => s.split(/\s+/u).filter(Boolean).length;

/** The string sent to the embedding model for a chunk. */
export function embeddingInput(chunk: Pick<Chunk, "headingPath" | "text">): string {
  return chunk.headingPath.length > 0 ? `${chunk.headingPath.join(" › ")}\n${chunk.text}` : chunk.text;
}

interface Block {
  kind: "text" | "table";
  text: string;
}

interface Section {
  path: string[];
  blocks: Block[];
}

/** Splits Markdown into sections by ATX headings; each section's blocks are paragraphs or tables. */
function sections(markdown: string): Section[] {
  const out: Section[] = [];
  const path: string[] = [];
  let current: Section = { path: [], blocks: [] };
  let para: string[] = [];
  let table: string[] = [];
  let fence = false;

  const flushPara = () => {
    const t = para.join("\n").trim();
    if (t) current.blocks.push({ kind: "text", text: t });
    para = [];
  };
  const flushTable = () => {
    if (table.length) current.blocks.push({ kind: "table", text: table.join("\n") });
    table = [];
  };

  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flushPara();
      flushTable();
      if (current.blocks.length) out.push(current);
      const level = heading[1].length;
      path.length = Math.min(path.length, level - 1);
      // Missing levels (an h3 straight after an h1) leave no empty slot in the path.
      path.push(heading[2]);
      current = { path: [...path], blocks: [] };
      continue;
    }
    if (!fence && /^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      table.push(line.trim());
      continue;
    }
    flushTable();
    if (!fence && line.trim() === "") flushPara();
    else para.push(line);
  }
  flushPara();
  flushTable();
  if (current.blocks.length) out.push(current);
  return out;
}

/** Splits text that is too long by sentences, then by words when a sentence alone is too long. */
function splitLong(text: string, max: number): string[] {
  if (estimateTokens(text) <= max) return [text];
  const sentences = text.match(/[^.!?؟।\n]+[.!?؟।]*\s*|\n+/gu) ?? [text];
  const parts: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (estimateTokens(s) > max) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      let words: string[] = [];
      for (const w of s.split(/\s+/u).filter(Boolean)) {
        if (words.length && estimateTokens([...words, w].join(" ")) > max) {
          parts.push(words.join(" "));
          words = [];
        }
        words.push(w);
      }
      if (words.length) buf = words.join(" ");
      continue;
    }
    if (buf && estimateTokens(buf + s) > max) {
      parts.push(buf.trim());
      buf = "";
    }
    buf += s;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/** A table over the limit becomes runs of rows, each with the header and separator repeated. */
function splitTable(table: string, max: number): string[] {
  if (estimateTokens(table) <= max) return [table];
  const rows = table.split("\n");
  const hasHeader = rows.length > 1 && /^\|\s*:?-{3,}/.test(rows[1] ?? "");
  const head = hasHeader ? rows.slice(0, 2) : [];
  const body = hasHeader ? rows.slice(2) : rows;
  const out: string[] = [];
  let run: string[] = [];
  for (const row of body) {
    if (run.length && estimateTokens([...head, ...run, row].join("\n")) > max) {
      out.push([...head, ...run].join("\n"));
      run = [];
    }
    run.push(row);
  }
  if (run.length) out.push([...head, ...run].join("\n"));
  return out;
}

/** The tail of `text` worth about `tokens` tokens, cut at a word boundary. */
function tail(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  const words = text.split(/\s+/u).filter(Boolean);
  const kept: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const next = [words[i] as string, ...kept];
    if (estimateTokens(next.join(" ")) > tokens) break;
    kept.unshift(words[i] as string);
  }
  return kept.join(" ");
}

export function chunkMarkdown(markdown: string, options: ChunkOptions = CHUNK_DEFAULTS): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (path: string[], text: string, kind: Chunk["kind"]) => {
    chunks.push({ ordinal: chunks.length, headingPath: path, text, tokenCount: estimateTokens(text), kind });
  };

  for (const section of sections(markdown)) {
    let buf = "";
    let overlapFrom = "";
    const flush = () => {
      if (!buf.trim()) return;
      push(section.path, buf.trim(), "text");
      overlapFrom = buf;
      buf = "";
    };
    for (const block of section.blocks) {
      if (block.kind === "table") {
        // Tables are atomic and never share a chunk with prose (ADR-007 §5).
        flush();
        for (const part of splitTable(block.text, options.maxTokens)) push(section.path, part, "table");
        overlapFrom = "";
        continue;
      }
      for (const piece of splitLong(block.text, options.maxTokens)) {
        const joined = buf ? `${buf}\n\n${piece}` : piece;
        if (buf && estimateTokens(joined) > options.targetTokens) {
          flush();
          const carry = tail(overlapFrom, Math.floor(options.targetTokens * options.overlap));
          const withCarry = carry ? `${carry}\n\n${piece}` : piece;
          buf = estimateTokens(withCarry) <= options.maxTokens ? withCarry : piece;
        } else {
          buf = joined;
        }
      }
    }
    flush();
  }
  return chunks;
}
