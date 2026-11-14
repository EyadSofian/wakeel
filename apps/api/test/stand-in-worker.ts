import { emptyState, newId } from "@wakeel/contracts";
import {
  acquireConversationLease,
  appendOutbox,
  type Database,
  finishTurn,
  getConversation,
  insertBotMessages,
  nextUnprocessedEvent,
  releaseConversationLease,
  startTurn,
  upsertSpans,
  writeConversation,
} from "@wakeel/db";
import type { Redis } from "ioredis";

/**
 * A stand-in for apps/worker (apps never import each other, CLAUDE.md §4), built from the same
 * repository calls the real worker makes. Each turn answers "رد: <text>" (or the event's name, or
 * the node of a run_from), writes a turn span, emits typing, message.created and turn.completed,
 * then signals. An `end` event ends the conversation instead, as the engine does.
 */
export function standInWorker(db: Database, publisher: Redis) {
  return async function work(conversationId: string): Promise<void> {
    const ws = await db.lookup.conversationWorkspace(conversationId);
    if (!ws) return;
    const epoch = await db.withWorkspace(ws, (tx) => acquireConversationLease(tx, conversationId, "stand-in", 30_000));
    if (epoch === undefined) return;
    for (;;) {
      const done = await db.withWorkspace(ws, async (tx) => {
        const ev = await nextUnprocessedEvent(tx, conversationId);
        if (!ev) return undefined;
        const conv = await getConversation(tx, conversationId);
        const turn = await startTurn(tx, {
          conversationId,
          botId: conv.botId,
          versionId: null,
          epoch,
          eventIds: [ev.id],
          id: ev.payload["turnId"] as string,
        });
        if (ev.kind === "handoff_release" || (ev.kind === "message" && conv.status === "handed_off")) {
          // As the engine: a release goes idle and clears the handoff; a message while handed off is
          // only recorded (§9.4).
          const released = ev.kind === "handoff_release";
          if (released)
            await writeConversation(tx, conversationId, epoch, { state: { ...emptyState() }, handoff: null });
          const status = released ? "completed" : "handed_off";
          await appendOutbox(tx, { conversationId, connectionId: ev.connectionId, epoch }, [
            { type: "turn.completed", payload: { turnId: turn.id, data: { status, messageCount: 0, durationMs: 1 } } },
          ]);
          await finishTurn(tx, { turnId: turn.id, status, stepCount: released ? 1 : 0 });
          return ev.seq;
        }
        if (ev.kind === "end") {
          // endConversation (ADR-029 §1), as the engine does it: state cleared, conversation.ended.
          await writeConversation(tx, conversationId, epoch, {
            state: { ...emptyState(), status: "ended" },
            endedReason: "manual",
          });
          await appendOutbox(tx, { conversationId, connectionId: ev.connectionId, epoch }, [
            { type: "conversation.ended", payload: { turnId: turn.id, data: { reason: "manual" } } },
            {
              type: "turn.completed",
              payload: { turnId: turn.id, data: { status: "ended", messageCount: 0, durationMs: 1 } },
            },
          ]);
          await finishTurn(tx, { turnId: turn.id, status: "ended", stepCount: 1 });
          return ev.seq;
        }
        const message = ev.payload["message"] as { text?: string } | undefined;
        const reply = {
          type: "text",
          text: `رد: ${message?.text ?? ev.payload["name"] ?? ev.payload["nodeId"]}`,
          format: "markdown",
        };
        const [stored] = await insertBotMessages(tx, conversationId, [
          { id: newId("msg"), type: "text", payload: reply, turnId: turn.id },
        ]);
        if (!stored) throw new Error("no message stored");
        // The trace, as apps/worker writes it (task 4.7): here just the turn span.
        await upsertSpans(tx, [
          {
            id: newId("span"),
            workspaceId: ws,
            botId: conv.botId,
            conversationId,
            turnId: turn.id,
            seq: 0,
            name: "Turn",
            status: "ok",
            startedAt: new Date().toISOString(),
            durationMs: 5,
            location: {},
            kind: "turn",
            attrs: { trigger: "message", mode: conv.mode as "live" | "emulator" | "eval", outcome: "completed" },
          },
        ]);
        const at = { conversationId, connectionId: ev.connectionId, epoch };
        await appendOutbox(tx, at, [
          { type: "typing", payload: { turnId: turn.id, data: { state: "on" } }, ephemeral: true },
          {
            type: "message.created",
            payload: {
              turnId: turn.id,
              data: {
                message: {
                  id: stored.id,
                  conversationId,
                  seq: stored.seq,
                  direction: "out",
                  payload: reply,
                  citations: [],
                  turnId: turn.id,
                  createdAt: stored.createdAt.toISOString(),
                },
              },
            },
          },
          {
            type: "turn.completed",
            payload: { turnId: turn.id, data: { status: "completed", messageCount: 1, durationMs: 5 } },
          },
        ]);
        await finishTurn(tx, { turnId: turn.id, status: "completed", stepCount: 1 });
        return ev.seq;
      });
      if (done === undefined) break;
      await publisher.publish(`conversation-events:${conversationId}`, "");
      await publisher.publish(`turn-done:${conversationId}:${done}`, "{}");
    }
    await db.withWorkspace(ws, (tx) => releaseConversationLease(tx, conversationId, epoch));
  };
}
