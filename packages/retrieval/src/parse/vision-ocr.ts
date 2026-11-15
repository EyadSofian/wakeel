import type { OcrPort } from "./client";

/**
 * The OCR tier's prompt (ADR-040). The page image is user content; the instructions are fixed
 * platform text. The model transcribes; it must not summarise, translate or answer the page.
 */
export const OCR_SYSTEM = [
  "You transcribe document pages into Markdown for a search index.",
  "Write every word on the page exactly as printed, in reading order. Arabic is written right to left: keep logical order, keep diacritics, and keep Arabic-Indic or Western digits as printed.",
  "Use # headings for headings by size, | tables | for tables with every cell, and - for list items.",
  "Do not translate, summarise, correct or answer anything on the page. Do not add commentary. If the page is blank, answer with nothing.",
].join("\n");

export const OCR_INSTRUCTION = "Transcribe this page.";

/** What the OCR tier needs from the model layer; `packages/llm`'s `readImage` fits. */
export type ReadImage = (input: {
  system: string;
  instruction: string;
  image: Uint8Array;
  mediaType: "image/png";
  maxOutputTokens: number;
}) => Promise<{ text: string }>;

/** An `OcrPort` over a vision model. The worker binds the model, workspace and usage context. */
export function visionOcr(readImage: ReadImage): OcrPort {
  return {
    async ocrPage({ png }) {
      const out = await readImage({
        system: OCR_SYSTEM,
        instruction: OCR_INSTRUCTION,
        image: png,
        mediaType: "image/png",
        maxOutputTokens: 4_000,
      });
      // Models sometimes fence the whole answer; the index wants the Markdown inside.
      return out.text.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/u, "$1").trim();
    },
  };
}
