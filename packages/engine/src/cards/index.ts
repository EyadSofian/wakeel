import type { CardExecutors } from "../ports";

/**
 * The engine's card executors, by card type. Task 4.3 adds say, capture, branch, set_variable,
 * code, log, end, set_timeout and call_workflow; later phases add the AI, knowledge and table cards.
 * A card type with no executor fails its step with `internal_error`.
 */
export const CARD_EXECUTORS: CardExecutors = {};
