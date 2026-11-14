/**
 * The embedder (architecture §8.1 "Embed"): batches the chunks' embedding inputs through the model
 * layer and fits every vector to the index's 1024 dimensions. Models with more dimensions are
 * truncated and re-normalised (the Matryoshka-trained models in the registry support this); a model
 * with fewer cannot be used for a 1024-dimension index.
 */
export const INDEX_DIMS = 1024;

export type EmbedBatch = (values: string[]) => Promise<number[][]>;

export class EmbeddingDimensionError extends Error {
  constructor(readonly dims: number) {
    super(`the embedding model returned ${dims} dimensions; the index needs at least ${INDEX_DIMS}`);
  }
}

/** Truncates to `dims` and scales to unit length, so cosine distance stays meaningful. */
export function fitVector(v: number[], dims = INDEX_DIMS): number[] {
  if (v.length < dims) throw new EmbeddingDimensionError(v.length);
  const cut = v.slice(0, dims);
  const norm = Math.sqrt(cut.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? cut.map((x) => x / norm) : cut;
}

export async function embedAll(embed: EmbedBatch, inputs: string[], batchSize = 64): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const vectors = await embed(batch);
    if (vectors.length !== batch.length) throw new Error(`asked for ${batch.length} embeddings, got ${vectors.length}`);
    out.push(...vectors.map((v) => fitVector(v)));
  }
  return out;
}
