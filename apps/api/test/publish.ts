import type { Workflow } from "@wakeel/contracts";
import { listDraftDocs, publishDraft, saveDraftDoc, type Tx } from "@wakeel/db";

/**
 * Publishes a freshly seeded bot so its production connections accept messages (ADR-036): the
 * seeded Autonomous node gets the instructions it lacks, then the draft is published as version 1.
 */
export async function publishSeeded(tx: Tx, botId: string, userId: string | null = null): Promise<string> {
  const main = (await listDraftDocs(tx, botId)).find((d) => d.kind === "workflow");
  if (!main) throw new Error("the seeded bot has no workflow");
  const wf = main.doc as Workflow;
  await saveDraftDoc(tx, {
    botId,
    kind: "workflow",
    docId: wf.id,
    expectedRev: main.rev,
    doc: {
      ...wf,
      nodes: wf.nodes.map((n) =>
        n.type === "autonomous" && n.instructions.trim() === "" ? { ...n, instructions: "Help the customer." } : n,
      ),
    },
    userId,
  });
  const { version } = await publishDraft(tx, { botId, label: "Test", userId });
  return version.id;
}
