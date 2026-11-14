import { BRIDGE_EVENT_TYPES, type BridgeDelivery, ERRORS, type StudioConnection } from "@wakeel/contracts";
import type { Tone } from "@wakeel/ui";

/** Pure helpers for the Connections screens (task 5.5, design system §5.11). */

/** Event types in the order the API documents them, with what a builder reads. */
export const EVENT_LABELS: Record<(typeof BRIDGE_EVENT_TYPES)[number], { label: string; help: string }> = {
  "message.created": { label: "Messages", help: "Every message the bot sends." },
  typing: { label: "Typing", help: "When the bot starts and stops working on a reply. Not retried." },
  "handoff.requested": { label: "Handoff requests", help: "When the bot hands the conversation to a person." },
  "conversation.ended": { label: "Conversation ended", help: "When a conversation ends, and why." },
  "turn.completed": { label: "Turn finished", help: "When the bot has finished answering a message." },
  error: { label: "Errors", help: "When a turn fails." },
};
export const EVENT_TYPES = BRIDGE_EVENT_TYPES;

export const TARGET_LABELS = { production: "Published version", draft: "Draft" } as const;

export function connectionStatus(c: Pick<StudioConnection, "status">): { label: string; tone: Tone | undefined } {
  switch (c.status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "paused":
      return { label: "Paused", tone: undefined };
    case "disabled":
      return { label: "Turned off", tone: "error" };
  }
}

export function deliveryStatus(d: Pick<BridgeDelivery, "status">): { label: string; tone: Tone | undefined } {
  switch (d.status) {
    case "delivered":
      return { label: "Delivered", tone: "success" };
    case "pending":
      return { label: "Waiting", tone: undefined };
    case "failed":
      return { label: "Retrying", tone: "warning" };
    case "dead":
      return { label: "Failed", tone: "error" };
  }
}

/**
 * Egress's codes are worded in errors.ts for bot code and take placeholders a delivery has no
 * values for; for a webhook they read like this.
 */
const WEBHOOK_WORDING: Record<string, { title: string; fix: string }> = {
  fetch_blocked: {
    title: "The webhook address points to a private or internal network",
    fix: "Use a public https address for the webhook.",
  },
  fetch_failed: {
    title: "The webhook endpoint could not be reached",
    fix: "Check the address and that the receiving service is up.",
  },
  rate_limited: {
    title: "Too many webhooks were sent at once",
    fix: "Nothing to do: the event is sent again on the retry schedule.",
  },
};

/** A delivery error code as a sentence and its fix, from errors.ts; unknown codes show as they are. */
export function describeError(code: string | null | undefined): { title: string; fix: string } | undefined {
  if (!code) return undefined;
  const wording = WEBHOOK_WORDING[code];
  if (wording) return wording;
  const known = (ERRORS as Record<string, { title: string; fix: string } | undefined>)[code];
  return known ? { title: known.title, fix: known.fix } : { title: code, fix: "" };
}

/** Every code a delivery or a test event can carry (ADR-028 §10). */
export const DELIVERY_ERROR_CODES = [
  "webhook_rejected",
  "webhook_redirected",
  "webhook_secret_missing",
  "webhook_stale",
  "fetch_blocked",
  "fetch_failed",
  "rate_limited",
  "connection_disabled",
] as const;

/** The host of a webhook URL for the list, or the URL itself if it does not parse. */
export function webhookHost(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A delivery can be sent again when its latest attempt failed and nothing is pending (ADR-029 §3). */
export const canReplay = (d: Pick<BridgeDelivery, "status">) => d.status === "dead" || d.status === "failed";
