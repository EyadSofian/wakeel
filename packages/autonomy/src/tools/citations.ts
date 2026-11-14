import type { Citation } from "@wakeel/contracts";

/** A passage the model may cite, by its token (`c1`), as `kb_search` returns it (Phase 8). */
export type CitationSource = Omit<Citation, "index">;

const TOKEN = /\s*\[\[(c\d+)\]\]/g;

/**
 * Maps `[[cN]]` tokens in outgoing text to citations and strips them (architecture §6.5). Citations
 * are numbered in order of first use; a token with no source is stripped and cites nothing, so a
 * made-up token never reaches the user (ADR-035 §8).
 */
export function mapCitations(
  text: string,
  sources: Readonly<Record<string, CitationSource>>,
): { text: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const seen = new Map<string, number>();
  const stripped = text.replace(TOKEN, (_match, token: string) => {
    const source = sources[token];
    if (source && !seen.has(token)) {
      seen.set(token, citations.length + 1);
      citations.push({ ...source, index: citations.length + 1 });
    }
    return "";
  });
  return { text: stripped, citations };
}
