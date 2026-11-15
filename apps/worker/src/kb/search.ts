import { AppError, type SearchCitations, SearchRequest } from "@wakeel/contracts";
import { type Database, getWorkspace, resolveSearchBases, searchCandidates } from "@wakeel/db";
import type { KnowledgePort } from "@wakeel/engine";
import type { LlmClient, RerankHttpRequest } from "@wakeel/llm";
import { createSearch, queryTokens, type RetrievalTrace } from "@wakeel/retrieval";
import type { AutonomyTurn } from "../turn/autonomy";

export type { RetrievalRecord } from "@wakeel/contracts";

import type { RetrievalRecord } from "@wakeel/contracts";

/** The card, explicit tool and Code API share this bot-scoped retrieval service (ADR-043). */
export function turnKnowledge(
  deps: { db: Database; llm: Pick<LlmClient, "embed" | "rerank">; now?: () => number },
  turn: AutonomyTurn,
  record: (trace: RetrievalRecord) => void,
): KnowledgePort {
  // Guest Promise.all may issue searches concurrently. Serialize their citation allocation so later
  // replies cannot replace the source behind a label already returned to the model.
  let tail: Promise<void> = Promise.resolve();
  let citations: SearchCitations | undefined;
  return {
    search(raw, previous?: SearchCitations) {
      const run = tail.then(async () => {
        const request = SearchRequest.parse(raw);
        const now = deps.now ?? Date.now,
          start = now();
        let attrs: RetrievalTrace = {
          query: request.query,
          queryNormalised: queryTokens(request.query).join(" "),
          kbIds: request.kbIds,
          dense: [],
          lexical: [],
          fused: [],
          reranked: [],
          returned: 0,
        };
        const context = {
          workspaceId: turn.workspaceId,
          botId: turn.botId,
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          mode: turn.mode,
        };
        try {
          const settings = await deps.db.withWorkspace(turn.workspaceId, (tx) => getWorkspace(tx));
          const rerankModel = settings.settings.rerankModel;
          if (!rerankModel) throw new AppError("model_not_configured");
          const search = createSearch({
            resolve: (ids) => deps.db.withWorkspace(turn.workspaceId, (tx) => resolveSearchBases(tx, turn.botId, ids)),
            embed: async (model, query) => {
              const result = await deps.llm.embed({
                model: modelId(model),
                values: [query],
                purpose: "kb_query",
                context,
              });
              const vector = result.embeddings[0];
              if (!vector) throw new AppError("model_unavailable", { model });
              return vector;
            },
            candidates: (input) =>
              deps.db.withWorkspace(turn.workspaceId, (tx) => searchCandidates(tx, turn.botId, input)),
            rerank: (query, candidates) =>
              deps.llm.rerank({
                model: modelId(rerankModel),
                query,
                documents: candidates.map((c) => [...c.headingPath, c.text].join("\n")),
                purpose: "kb_rerank",
                context,
              }),
            trace: (trace) => {
              attrs = trace;
            },
          });
          const result = await search(request, citations ?? previous);
          citations = result.citations;
          record({ ...attrs, startedAt: new Date(start).toISOString(), durationMs: Math.max(0, now() - start) });
          return result;
        } catch (error) {
          record({
            ...attrs,
            startedAt: new Date(start).toISOString(),
            durationMs: Math.max(0, now() - start),
            error: error instanceof AppError ? error.code : "internal_error",
          });
          throw error;
        }
      });
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

function modelId(ref: string) {
  const at = ref.indexOf(":");
  return at < 0 ? ref : ref.slice(at + 1);
}

/** Provider-defined addresses pass through the same SSRF guard as every other tenant URL. */
export function rerankThroughEgress(options: { egressUrl: string; egressToken: string }) {
  return async (input: RerankHttpRequest): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(new URL("/v1/fetch", options.egressUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.egressToken}` },
      body: JSON.stringify({
        workspaceId: input.context.workspaceId,
        url: input.url,
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(input.body),
        bodyEncoding: "utf8",
        redirect: "manual",
        timeoutMs: 10_000,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status !== 200) throw new AppError("fetch_blocked");
    const raw: unknown = await response.json();
    if (
      !raw ||
      typeof raw !== "object" ||
      !("status" in raw) ||
      !("body" in raw) ||
      typeof raw.status !== "number" ||
      typeof raw.body !== "string"
    )
      throw new AppError("model_unavailable");
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(raw.body, "base64").toString("utf8"));
    } catch {
      throw new AppError("model_unavailable");
    }
    return { status: raw.status, body };
  };
}
