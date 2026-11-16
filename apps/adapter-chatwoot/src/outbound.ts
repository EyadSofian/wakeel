import type { BotMessagePayload, BridgeEvent } from "@wakeel/contracts";
import type { ChatwootClient } from "./chatwoot";
import type { Pair } from "./config";
import { numberedKey } from "./inbound";
import { DAY_SECONDS, type Store } from "./store";

/**
 * Platform → Chatwoot (chatwoot-adapter-spec §4). Every function throws when Chatwoot refuses, so the
 * webhook answers 5xx and the platform's retry and per-conversation ordering apply end to end.
 */

export interface OutboundDeps {
  pair: Pair;
  chatwoot: ChatwootClient;
  store: Store;
}

/** `cw-<account>-<conversation>` back to Chatwoot's numeric conversation id; undefined for foreign ids. */
export function chatwootConversationId(pair: Pair, externalId: string): number | undefined {
  const m = new RegExp(`^cw-${pair.chatwootAccountId}-(\\d+)$`).exec(externalId);
  return m ? Number(m[1]) : undefined;
}

export async function handleBridgeEvent(deps: OutboundDeps, event: BridgeEvent, channel?: string): Promise<void> {
  const id = chatwootConversationId(deps.pair, event.conversation.externalId);
  if (id === undefined) return;
  const cw = deps.chatwoot;
  switch (event.type) {
    case "message.created":
      return sendBotMessage(deps, id, event.data.message.payload, channel);
    case "typing":
      return cw.typing(id, event.data.state);
    case "handoff.requested":
      return handoff(deps, id, event.data.reason, event.data.summary);
    case "conversation.ended":
      if (event.data.reason === "completed" && deps.pair.autoResolve) await cw.setStatus(id, "resolved");
      return;
    case "error":
      await cw.privateNote(id, `The assistant hit an error: ${event.data.code}. ${event.data.message}`.slice(0, 2_000));
      if (!event.data.retryable) await handoff(deps, id, "assistant_error", "");
      return;
    case "turn.completed":
      return;
  }
}

/** Note for the agent, open the conversation, route it, label it (spec §4 handoff.requested). */
async function handoff(deps: OutboundDeps, id: number, reason: string, summary: string): Promise<void> {
  const cw = deps.chatwoot;
  const lines = [reason ? `Handoff reason: ${reason}` : "Handoff requested by the assistant", summary].filter(Boolean);
  await cw.privateNote(id, lines.join("\n\n").slice(0, 4_000));
  await cw.setStatus(id, "open");
  const { handoffTeamId, handoffAssigneeId } = deps.pair;
  if (handoffTeamId || handoffAssigneeId) {
    await cw.assign(id, {
      ...(handoffTeamId ? { teamId: handoffTeamId } : {}),
      ...(handoffAssigneeId ? { assigneeId: handoffAssigneeId } : {}),
    });
  }
  await cw.addLabels(id, ["bot-handoff"]);
}

async function sendBotMessage(
  deps: OutboundDeps,
  id: number,
  payload: BotMessagePayload,
  channel: string | undefined,
): Promise<void> {
  const cw = deps.chatwoot;
  const selectable = channel === undefined || deps.pair.selectChannels.includes(channel);
  switch (payload.type) {
    case "text":
      return cw.sendMessage(id, { content: payload.text });
    case "choice":
    case "dropdown": {
      if (selectable) {
        return cw.sendMessage(id, {
          content: payload.text,
          content_type: "input_select",
          content_attributes: { items: payload.options.map((o) => ({ title: o.label, value: o.value })) },
        });
      }
      // No buttons on this channel: a numbered list, remembered so "2" or "٢" becomes a postback.
      await deps.store.setJson(
        numberedKey(deps.pair, id),
        payload.options.map((o) => o.value),
        DAY_SECONDS,
      );
      const list = payload.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
      return cw.sendMessage(id, { content: `${payload.text}\n\n${list}` });
    }
    case "card":
    case "carousel": {
      const items = payload.type === "card" ? [payload] : payload.items;
      return cw.sendMessage(id, {
        content: items.map((c) => c.title).join("\n"),
        content_type: "cards",
        content_attributes: {
          items: items.map((c) => ({
            title: c.title,
            ...(c.subtitle ? { description: c.subtitle } : {}),
            ...(c.imageUrl ? { media_url: c.imageUrl } : {}),
            actions: c.actions.map((a) =>
              a.type === "url"
                ? { type: "link", text: a.label, uri: a.value }
                : { type: "postback", text: a.label, payload: a.value },
            ),
          })),
        },
      });
    }
    case "image":
      return cw.sendMessage(id, { content: [payload.caption, payload.url].filter(Boolean).join("\n") });
    case "file":
      return cw.sendMessage(id, { content: `${payload.name}\n${payload.url}` });
    case "location": {
      const link = `https://www.google.com/maps?q=${payload.latitude},${payload.longitude}`;
      return cw.sendMessage(id, { content: [payload.title, payload.address, link].filter(Boolean).join("\n") });
    }
    case "custom":
      if (payload.name === "chatwoot" && payload.data && typeof payload.data === "object") {
        return cw.sendMessage(id, payload.data as Record<string, unknown>);
      }
      return;
  }
}
