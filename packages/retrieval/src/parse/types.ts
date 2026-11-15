import { z } from "zod";

/** The parser service's answer (`apps/parser`, ADR-040). Pages carry an image only when low on text. */
export const ParserPage = z.object({
  number: z.number().int().positive(),
  markdown: z.string(),
  chars: z.number().int().nonnegative(),
  /** Base64 PNG, for the OCR tier. */
  image: z.string().optional(),
  /** Why the image is attached (ADR-040): a scan, or Arabic text the PDF backends extract broken. */
  ocrReason: z.enum(["low_text", "arabic"]).optional(),
});
export type ParserPage = z.infer<typeof ParserPage>;

export const ParserHeading = z.object({
  level: z.number().int().min(1).max(7),
  text: z.string(),
  page: z.number().int().positive().nullable(),
});

export const ParserTable = z.object({
  page: z.number().int().positive().nullable(),
  rows: z.array(z.array(z.string())),
});

export const ParserResponse = z.object({
  title: z.string().nullable(),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(ParserPage),
  tables: z.array(ParserTable),
  headings: z.array(ParserHeading),
});
export type ParserResponse = z.infer<typeof ParserResponse>;

/** Scores in [0, 1], 1 being clean; `warnings` are shown on the document in the Studio. */
export interface ParseQuality {
  score: number;
  textDensity: number;
  replacementRatio: number;
  /** Share of Arabic text that looks like visual-order or presentation-form extraction. */
  rtlDisorder: number;
  warnings: ParseWarning[];
}

export type ParseWarning = "low_text" | "replacement_characters" | "rtl_order" | "ocr_used" | "ocr_capped";

/** What every source becomes before chunking (architecture §8.1, "parse"). */
export interface ParsedDocument {
  title: string | null;
  /** The whole document as Markdown: pages joined in order, OCR text in place of image-only pages. */
  markdown: string;
  pages: { number: number; chars: number; ocr: boolean }[];
  via: "docling" | "readability" | "text";
  quality: ParseQuality;
}
