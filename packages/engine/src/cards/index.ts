import type { CardExecutors } from "../ports";
import { aiBranch } from "./ai-branch";
import { aiExtract } from "./ai-extract";
import { aiGenerate } from "./ai-generate";
import { branch } from "./branch";
import { callWorkflow } from "./call-workflow";
import { capture } from "./capture";
import { code } from "./code";
import { handoff } from "./handoff";
import { kbSearch } from "./kb-search";
import { say } from "./say";
import { setVariable } from "./set-variable";
import { end, log, setTimeoutCard } from "./simple";
import { table } from "./table";

export { normalizeDigits, parseReply } from "./capture-parse";
export { CardEvaluator, checkMessage, renderMessages } from "./render";

/**
 * The engine's card executors by card type. A missing executor fails the step with `internal_error`.
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
  ai_generate: aiGenerate,
  ai_extract: aiExtract,
  ai_branch: aiBranch,
  kb_search: kbSearch,
  table,
};
