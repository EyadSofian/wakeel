import { type EventScope, type Json, UserMessagePayload } from "@wakeel/contracts";
import type { InboundEventRecord } from "@wakeel/db";

/**
 * The `event` scope for a turn, from its inbound events (architecture §4.5). Inbound payloads, as
 * the Bridge API (4.5) writes them:
 *
 *   message          { message: UserMessagePayload, metadata?, externalMessageId? }
 *   event            { name, payload? }
 *   user_update      { attributes }
 *   tool_result      { toolCallId, ... }
 *   handoff_release  {}
 *   timeout          {}
 *   run_from         { workflowId, nodeId }   (Studio emulator only, ADR-025)
 *
 * Several text messages coalesced into one turn become one message whose text is theirs joined by
 * line breaks, in order.
 */
export function eventScope(
  events: readonly InboundEventRecord[],
  conversation: { id: string; externalId: string },
  user: { id: string; externalId: string },
): EventScope {
  const [first] = events;
  if (!first) throw new Error("a turn has at least one event");
  const base = {
    kind: first.kind as EventScope["kind"],
    conversationId: conversation.id,
    externalConversationId: conversation.externalId,
    userId: user.id,
    externalUserId: user.externalId,
    receivedAt: first.receivedAt.toISOString(),
  };
  const p = first.payload;
  const object = (v: Json | undefined): Record<string, Json> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {};

  if (first.kind === "message") {
    const parsed = UserMessagePayload.safeParse(p["message"]);
    const message = parsed.success ? parsed.data : undefined;
    let text = message ? messageText(message) : "";
    let merged = message;
    if (events.length > 1 && message?.type === "text") {
      text = events.map((e) => messageText(UserMessagePayload.parse(e.payload["message"]))).join("\n");
      merged = { ...message, text };
    }
    return { ...base, text, ...(merged ? { message: merged } : {}), payload: {}, metadata: object(p["metadata"]) };
  }
  if (first.kind === "event") {
    const name = typeof p["name"] === "string" ? p["name"] : "";
    return { ...base, text: "", name, payload: object(p["payload"]), metadata: {} };
  }
  return { ...base, text: "", payload: p, metadata: {} };
}

/** The text of a user message: its text, or a postback's label (or value). */
export function messageText(message: UserMessagePayload): string {
  if (message.type === "text") return message.text;
  if (message.type === "postback") return message.label ?? message.value;
  return "";
}

/** Whether an event can be coalesced: a plain text message. */
export function isTextMessage(event: InboundEventRecord): boolean {
  if (event.kind !== "message") return false;
  const parsed = UserMessagePayload.safeParse(event.payload["message"]);
  return parsed.success && parsed.data.type === "text";
}
