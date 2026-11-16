import type { Queue } from "bullmq";
import { describe, expect, test } from "vitest";
import { ingestEmbedder, ingestEnqueuer } from "../src/kb";

/**
 * Two production failures found while migrating the Majed pilot (2026-11-16): every embed stage
 * failed with model_not_configured, and a document whose stage had failed could never be re-ingested.
 */

type Added = { name: string; data: unknown; opts: { jobId?: string } };

function fakeQueue(existing: Record<string, "failed" | "waiting">) {
  const added: Added[] = [];
  const removed: string[] = [];
  const queue = {
    async getJob(id: string) {
      const state = existing[id];
      if (!state) return undefined;
      return {
        isFailed: async () => state === "failed",
        remove: async () => {
          removed.push(id);
          delete existing[id];
        },
      };
    },
    async add(name: string, data: unknown, opts: { jobId?: string }) {
      // BullMQ drops an add whose jobId already exists, whatever that job's state.
      if (opts.jobId && existing[opts.jobId]) return undefined;
      added.push({ name, data, opts });
      return {};
    },
  };
  return { queue: queue as unknown as Queue, added, removed };
}

const job = { workspaceId: "ws_1", documentId: "doc_1", stage: "embed" as const };

describe("ingestEnqueuer", () => {
  test("a failed job with the same id is removed so the stage runs again", async () => {
    const q = fakeQueue({ "doc_1-embed": "failed" });
    await ingestEnqueuer(q.queue)(job);
    expect(q.removed).toEqual(["doc_1-embed"]);
    expect(q.added.map((a) => a.opts.jobId)).toEqual(["doc_1-embed"]);
  });

  test("a job still waiting is kept: the duplicate request is dropped", async () => {
    const q = fakeQueue({ "doc_1-embed": "waiting" });
    await ingestEnqueuer(q.queue)(job);
    expect(q.removed).toEqual([]);
    expect(q.added).toEqual([]);
  });
});

describe("ingestEmbedder", () => {
  test("passes the registry id, not the knowledge base's provider:id reference", async () => {
    const calls: { model: string; purpose: string }[] = [];
    const llm = {
      embed: async (req: { model: string; values: string[]; purpose: string }) => {
        calls.push({ model: req.model, purpose: req.purpose });
        return { embeddings: req.values.map(() => [0.1]) };
      },
    };
    const embed = ingestEmbedder(llm)({ workspaceId: "ws_1", botId: "bot_1", model: "openai:text-embedding-3-large" });
    expect(await embed(["مرحبا"])).toEqual([[0.1]]);
    expect(calls).toEqual([{ model: "text-embedding-3-large", purpose: "kb_embed" }]);
  });
});
