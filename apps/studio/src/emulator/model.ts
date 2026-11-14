import {
  type BotMessagePayload,
  type BridgeEvent,
  type Citation,
  type EmulatorStateResponse,
  ERRORS,
  type UserMessagePayload,
} from "@wakeel/contracts";

/**
 * The emulator's transcript as pure data (task 4.6): user messages appear at once, bot output comes
 * from the turn's Bridge events as SSE delivers them. Kept free of React and of the network so the
 * reducer can be tested on its own.
 */
export type TranscriptEntry =
  | {
      kind: "message";
      key: string;
      direction: "in" | "out";
      payload: BotMessagePayload | UserMessagePayload;
      citations: Citation[];
      /** The newest bot message's buttons are usable; earlier ones are history. */
      live: boolean;
    }
  | { kind: "error"; key: string; code: string; title: string; fix: string }
  | { kind: "handoff"; key: string; reason: string }
  | { kind: "ended"; key: string; reason: string }
  | { kind: "footer"; key: string; durationMs: number; status: string }
  /** The request itself failed (network, validation, permission): the API's problem document. */
  | { kind: "problem"; key: string; title: string; fix: string };

export interface Transcript {
  items: TranscriptEntry[];
  /** A turn is in flight: from the user's message until `turn.completed` (or a failed request). */
  running: boolean;
  typing: boolean;
  /** The conversation's status as the events tell it. */
  status: "active" | "handed_off" | "ended";
  /** Event ids already applied; SSE, retries and replays may repeat one. */
  seen: ReadonlySet<string>;
  /** Local ids for user messages. */
  counter: number;
}

export const emptyTranscript = (): Transcript => ({
  items: [],
  running: false,
  typing: false,
  status: "active",
  seen: new Set(),
  counter: 0,
});

/** The builder's message, shown before the API has answered. */
export function userMessage(t: Transcript, text: string): Transcript {
  return appendUser(t, { type: "text", text, format: "plain" });
}

/** A picked button or dropdown option, shown as the user's bubble with its label. */
export function userPostback(t: Transcript, value: string, label: string): Transcript {
  return appendUser(t, { type: "postback", value, label });
}

function appendUser(t: Transcript, payload: UserMessagePayload): Transcript {
  const items = t.items.map((i) => (i.kind === "message" && i.live ? { ...i, live: false } : i));
  const counter = t.counter + 1;
  return {
    ...t,
    counter,
    items: [
      ...items,
      { kind: "message", key: `local-${counter}`, direction: "in", payload, citations: [], live: false },
    ],
  };
}

export const startTurn = (t: Transcript): Transcript => ({ ...t, running: true, typing: false });

/** The request failed before or during the turn; the transcript says why and the turn stops. */
export function requestFailed(t: Transcript, problem: { title: string; fix?: string | undefined }): Transcript {
  const counter = t.counter + 1;
  return {
    ...t,
    counter,
    running: false,
    typing: false,
    items: [
      ...t.items,
      { kind: "problem", key: `problem-${counter}`, title: problem.title, fix: problem.fix ?? "Try again." },
    ],
  };
}

/** One Bridge event from the turn's stream. */
export function applyEvent(t: Transcript, event: BridgeEvent): Transcript {
  if (t.seen.has(event.id)) return t;
  const seen = new Set(t.seen).add(event.id);
  const next = { ...t, seen };
  switch (event.type) {
    case "typing":
      return { ...next, typing: event.data.state === "on" && t.running };
    case "message.created": {
      const m = event.data.message;
      const items = t.items.map((i) => (i.kind === "message" && i.live ? { ...i, live: false } : i));
      return {
        ...next,
        typing: false,
        items: [
          ...items,
          { kind: "message", key: m.id, direction: "out", payload: m.payload, citations: m.citations, live: true },
        ],
      };
    }
    case "error": {
      const { title, fix } = describeError(event.data.code, event.data.message);
      return {
        ...next,
        typing: false,
        items: [...t.items, { kind: "error", key: event.id, code: event.data.code, title, fix }],
      };
    }
    case "handoff.requested":
      return {
        ...next,
        status: "handed_off",
        items: [...t.items, { kind: "handoff", key: event.id, reason: event.data.reason }],
      };
    case "conversation.ended":
      return {
        ...next,
        status: "ended",
        items: [...t.items, { kind: "ended", key: event.id, reason: event.data.reason }],
      };
    case "turn.completed":
      return {
        ...next,
        running: false,
        typing: false,
        items: [
          ...t.items,
          { kind: "footer", key: event.id, durationMs: event.data.durationMs, status: event.data.status },
        ],
      };
  }
}

/**
 * The title and fix for an error event, from `errors.ts`. Error events carry no parameters, so a
 * title with a `{placeholder}` gives way to the event's own message, which names the specifics.
 */
export function describeError(code: string, message: string): { title: string; fix: string } {
  const known = (ERRORS as Record<string, { title: string; fix: string } | undefined>)[code];
  if (!known) return { title: message, fix: "Open the trace to see where it failed." };
  const hasParams = (s: string) => /\{[a-zA-Z]+\}/.test(s);
  return {
    title: hasParams(known.title) ? message : known.title,
    fix: hasParams(known.fix) ? "Open the trace to see where it failed." : known.fix,
  };
}

/** Variable ids whose value is new or different since the previous snapshot (the Variables tab). */
export function changedVariables(
  before: EmulatorStateResponse | undefined,
  after: EmulatorStateResponse,
): ReadonlySet<string> {
  if (!before) return new Set();
  const old = new Map(before.variables.map((v) => [v.id, JSON.stringify(v.value)]));
  return new Set(after.variables.filter((v) => old.get(v.id) !== JSON.stringify(v.value)).map((v) => v.id));
}
