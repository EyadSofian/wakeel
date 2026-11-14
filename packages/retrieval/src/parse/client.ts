import { AppError } from "@wakeel/contracts";
import { scoreQuality } from "./quality";
import { type ParsedDocument, ParserResponse } from "./types";

/**
 * The parser service client and the OCR tier (task 8.2, ADR-040). The parser has no network, so it
 * cannot call a vision model; it returns an image of each page with almost no text, and this module
 * sends those images to the vision model through `OcrPort`, at most `maxOcrPages` per document.
 */

/** Calls `apps/parser`. A port so the worker's tests can fake it. */
export interface ParserPort {
  parse(input: { body: Uint8Array; mime: string; name: string }): Promise<ParserResponse>;
}

/** Reads text from one page image with a vision model (wired to `packages/llm` by the worker). */
export interface OcrPort {
  /** Answers the page's text as Markdown, in reading order. */
  ocrPage(input: { png: Uint8Array; page: number }): Promise<string>;
}

export function httpParser(config: {
  url: string;
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): ParserPort {
  const doFetch = config.fetch ?? fetch;
  return {
    async parse({ body, mime, name }) {
      let res: Response;
      try {
        res = await doFetch(new URL("/v1/parse", config.url), {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": mime,
            // Header values are Latin-1; the name is only a hint, so encode it.
            "x-file-name": encodeURIComponent(name),
          },
          body,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (e) {
        throw new AppError("document_parse_failed", { document: name }, { cause: e });
      }
      if (!res.ok) {
        // The parser's problem titles are written for builders; pass them through as the reason.
        const detail = (await res.json().catch(() => ({}))) as { title?: unknown };
        throw new AppError(
          "document_parse_failed",
          { document: name },
          { detail: typeof detail.title === "string" ? detail.title : `HTTP ${res.status}` },
        );
      }
      return ParserResponse.parse(await res.json());
    },
  };
}

export interface ParseFileOptions {
  parser: ParserPort;
  ocr?: OcrPort;
  /** Risk note in the plan: OCR costs money, so it is capped per document. */
  maxOcrPages: number;
}

/** Parses an uploaded PDF, Office file or image, running the OCR tier on image-only pages. */
export async function parseWithParser(
  input: { body: Uint8Array; mime: string; name: string },
  options: ParseFileOptions,
): Promise<ParsedDocument> {
  const res = await options.parser.parse(input);
  const needing = res.pages.filter((p) => p.image !== undefined);
  const ocrTargets = options.ocr ? needing.slice(0, options.maxOcrPages) : [];
  const ocrText = new Map<number, string>();
  for (const p of ocrTargets) {
    const png = Uint8Array.from(Buffer.from(p.image ?? "", "base64"));
    ocrText.set(p.number, (await options.ocr?.ocrPage({ png, page: p.number }))?.trim() ?? "");
  }
  const pages = res.pages.map((p) => {
    const text = ocrText.get(p.number);
    const markdown = text !== undefined ? text : p.markdown;
    return { number: p.number, markdown, chars: text !== undefined ? letters(text) : p.chars, ocr: text !== undefined };
  });
  const markdown = pages
    .map((p) => p.markdown.trim())
    .filter((m) => m.length > 0)
    .join("\n\n");
  return {
    title: res.title,
    markdown,
    pages: pages.map(({ number, chars, ocr }) => ({ number, chars, ocr })),
    via: "docling",
    quality: scoreQuality({
      // Only extracted text is judged for replacement characters and order; OCR text is the model's.
      text: pages
        .filter((p) => !p.ocr)
        .map((p) => p.markdown)
        .join("\n"),
      pageChars: pages.map((p) => p.chars),
      ocrPages: ocrTargets.length,
      ocrCapped: needing.length > ocrTargets.length,
    }),
  };
}

/** How many pages would go to OCR, shown before the builder starts an expensive run. */
export function ocrEstimate(res: ParserResponse, maxOcrPages: number): { pages: number; capped: boolean } {
  const n = res.pages.filter((p) => p.image !== undefined).length;
  return { pages: Math.min(n, maxOcrPages), capped: n > maxOcrPages };
}

const letters = (s: string) => [...s].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
