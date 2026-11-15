/**
 * Splits text into chunks of `size` code points. Splitting by code point keeps surrogate pairs
 * (emoji) whole, while still cutting through Arabic words and protocol markers such as `:::` —
 * which is what the stream parser must survive.
 */
export function chunkText(text: string, size: number): string[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer; got ${size}`);
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

/** Splits text at the given code-point offsets, for tests that need a boundary in an exact place. */
export function splitAt(text: string, offsets: number[]): string[] {
  const chars = [...text];
  const cuts = [...new Set(offsets)].filter((o) => o > 0 && o < chars.length).sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    out.push(chars.slice(from, cut).join(""));
    from = cut;
  }
  out.push(chars.slice(from).join(""));
  return out;
}

/**
 * Every way to cut `text` into two chunks, for exhaustive boundary tests of a streaming parser:
 * `for (const chunks of everySplit(src)) parse(chunks)`.
 */
export function everySplit(text: string): string[][] {
  const n = [...text].length;
  return Array.from({ length: Math.max(n - 1, 0) }, (_, i) => splitAt(text, [i + 1]));
}
