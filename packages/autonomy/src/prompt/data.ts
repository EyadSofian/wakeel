/**
 * Data blocks (ADR-031 §3): untrusted content (tool output, KB passages, the summary, variable values)
 * goes to the model inside `<data source="…">` … `</data>`, in user-role messages only. A `</data`
 * inside the content is written `<\/data`, so content cannot close its own block.
 */
export function dataBlock(source: string, content: string): string {
  const safeSource = source.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return `<data source="${safeSource}">\n${content.replace(/<\/data/gi, "<\\/data")}\n</data>`;
}
