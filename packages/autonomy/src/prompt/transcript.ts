import type { Json } from "@wakeel/contracts";

/** One transcript message as the window sees it. */
export interface TranscriptMessage {
  direction: "in" | "out";
  payload: Record<string, Json>;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

/** ADR-031 §2: a deliberately high estimate, since an overestimate only shrinks the window. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export const DEFAULT_WINDOW_TOKENS = 6_000;

/** A message as one line or block of text (ADR-031 §4): text as is, other types as a short description. */
export function describeMessage(payload: Record<string, Json>): string {
  const type = payload["type"];
  switch (type) {
    case "text":
      return String(payload["text"] ?? "");
    case "choice":
    case "dropdown": {
      const options = Array.isArray(payload["options"])
        ? (payload["options"] as { label?: Json }[]).map((o) => String(o.label ?? "")).join(" | ")
        : "";
      return `${String(payload["text"] ?? "")}\n[${type}: ${options}]`.trim();
    }
    case "image":
    case "file":
      return `[${type}${payload["caption"] ? `: ${String(payload["caption"])}` : payload["name"] ? `: ${String(payload["name"])}` : ""}]`;
    default:
      return `[${String(type ?? "message")}]`;
  }
}

/**
 * The newest messages that fit in `budget` tokens (architecture §6.4), oldest first, and the older
 * ones that did not fit (to be summarised). A single message larger than the budget is still kept,
 * so the latest user message is never dropped.
 */
export function windowTranscript(messages: readonly TranscriptMessage[], budget = DEFAULT_WINDOW_TOKENS) {
  const window: PromptMessage[] = [];
  let used = 0;
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const m = messages[i] as TranscriptMessage;
    const content = describeMessage(m.payload);
    const cost = estimateTokens(content);
    if (window.length > 0 && used + cost > budget) break;
    window.unshift({ role: m.direction === "in" ? "user" : "assistant", content });
    used += cost;
  }
  return { window, overflow: messages.slice(0, i + 1), tokens: used };
}
