import type { CardExecutors } from "../ports";
import { branch } from "./branch";
import { callWorkflow } from "./call-workflow";
import { capture } from "./capture";
import { code } from "./code";
import { handoff } from "./handoff";
import { say } from "./say";
import { setVariable } from "./set-variable";
import { end, log, setTimeoutCard } from "./simple";

export { normalizeDigits, parseReply } from "./capture-parse";
export { CardEvaluator, checkMessage, renderMessages } from "./render";

/**
 * The engine's card executors, by card type (tasks 4.3, 5.4). The AI, knowledge and table cards
 * arrive in later phases; a card type with no executor fails its step with `internal_error`.
 */
export const CARD_EXECUTORS: CardExecutors = {
  say,
  capture,
  branch,
  set_variable: setVariable,
  code,
  log,
  end,
  set_timeout: setTimeoutCard,
  call_workflow: callWorkflow,
  handoff,
};
