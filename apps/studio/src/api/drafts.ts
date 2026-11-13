import type { BotManifest, DraftDocResponse, Workflow } from "@wakeel/contracts";
import type { SaveDoc } from "../canvas/store/saver";
import { api } from "./client";

/** Loading and saving a bot's draft documents (task 2.1 API, used by the canvas store). */
interface BotDetail {
  id: string;
  name: string;
  docs: { kind: "manifest" | "workflow"; docId: string; rev: number }[];
}

export async function loadDraft(workspaceId: string, botId: string) {
  const base = `/v1/workspaces/${workspaceId}/bots/${botId}`;
  const detail = await api<BotDetail>("GET", base);
  const docs = await Promise.all(
    detail.docs.map((d) => api<DraftDocResponse>("GET", `${base}/docs/${d.kind}/${d.docId}`)),
  );
  const manifest = docs.find((d) => d.kind === "manifest");
  if (!manifest) throw new Error("The bot has no manifest document.");
  return {
    botId,
    manifest: { rev: manifest.rev, doc: manifest.doc as unknown as BotManifest },
    workflows: docs
      .filter((d) => d.kind === "workflow")
      .map((d) => ({ rev: d.rev, doc: d.doc as unknown as Workflow })),
  };
}

/** The saver's port: PUT with If-Match; a stale revision comes back as `revision_conflict`. */
export function draftSaver(workspaceId: string, botId: string): SaveDoc {
  return async (ref, rev, doc) => {
    const saved = await api<DraftDocResponse>(
      "PUT",
      `/v1/workspaces/${workspaceId}/bots/${botId}/docs/${ref.kind}/${ref.docId}`,
      { doc },
      { "if-match": `"${rev}"` },
    );
    return { rev: saved.rev };
  };
}
