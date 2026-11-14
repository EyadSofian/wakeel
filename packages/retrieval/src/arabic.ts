/**
 * Arabic normaliser and light stemmer (build plan 8.3). Not implemented yet: the tests in
 * test/arabic.test.ts describe the behaviour.
 */

export function normalizeArabic(_text: string): string {
  throw new Error("not implemented");
}

export function stemArabicWord(_word: string): string {
  throw new Error("not implemented");
}

export function lexicalTokens(_text: string): string[] {
  throw new Error("not implemented");
}

export const indexTokens = lexicalTokens;
export const queryTokens = lexicalTokens;
