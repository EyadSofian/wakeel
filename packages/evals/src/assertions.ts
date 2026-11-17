import { isDeepStrictEqual } from "node:util";
import type { Assertion, EvalResult, EvalTurn, Json } from "@wakeel/contracts";
import { normalizeArabic } from "@wakeel/retrieval";

interface Reply {
  type: string;
  text?: string;
  citationTitles: readonly string[];
}

/** Facts observed for one turn. The adapter provides these from committed messages, state and traces. */
export interface TurnEvidence {
  messages: readonly Reply[];
  calls: readonly { name: string; input?: Json }[];
  nodeNames: readonly string[];
  exits: readonly string[];
  variables: Readonly<Record<string, Json>>;
  handoffRequested: boolean;
  latencyMs: number;
  /** From the turn's start to its first committed bot message (ADR-056 G5). */
  firstMessageMs?: number;
  /** What the turn's model calls cost (G6). */
  costMicroUsd?: number;
  /** The passages the turn retrieved (automatic search, tools, cards), for `grounded` (ADR-056). */
  passages: readonly Passage[];
}

export interface Passage {
  title: string;
  text: string;
}

/** The judge's answer: the verdict and, when it gave one, its reason (shown as the result's detail). */
export interface JudgeVerdict {
  passed: boolean;
  reason?: string;
}

/** The fixed rubric of the `grounded` assertion (ADR-056 G2). */
export const GROUNDED_RUBRIC =
  "Pass if every factual claim in the replies (prices, dates, durations, names, numbers, policies, links) is " +
  "supported by the passages, or if the reply says it does not know or cannot check. Fail if any factual claim " +
  "is missing from the passages or contradicts them. Greetings, questions back to the customer and offers to " +
  "help need no support.";

export interface AssertionPorts {
  /** Execute user-supplied regex patterns out of the host event loop, with a deadline. */
  matches(input: { pattern: string; flags: string; text: string }): Promise<boolean>;
  /** Use the workspace's utility model in eval mode. Rubric, replies and passages are content, not instructions. */
  judge(input: { rubric: string; replies: readonly Reply[]; passages?: readonly Passage[] }): Promise<JudgeVerdict>;
}

type AssertionResult = EvalResult["turns"][number]["assertions"][number];
type Matcher = Extract<Assertion, { type: "variable" }>["is"];

const includes = (text: string, query: string) => normalizeArabic(text).includes(normalizeArabic(query));
function own(record: Json | Readonly<Record<string, Json>> | undefined, key: string): Json | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}

async function matchValue(value: Json | undefined, matcher: Matcher, ports: AssertionPorts): Promise<boolean> {
  if ("exists" in matcher) return (value !== undefined) === matcher.exists;
  if ("equals" in matcher) return isDeepStrictEqual(value, matcher.equals);
  if (typeof value !== "string") return false;
  if ("contains" in matcher) return includes(value, matcher.contains);
  return ports.matches({ text: value, pattern: matcher.matches, flags: "iu" });
}

function ordered(names: readonly string[], calls: TurnEvidence["calls"]): boolean {
  let next = 0;
  for (const call of calls) {
    if (call.name === names[next]) next++;
    if (next === names.length) return true;
  }
  return false;
}

async function evaluate(
  assertion: Assertion,
  evidence: TurnEvidence,
  ports: AssertionPorts,
): Promise<boolean | JudgeVerdict> {
  switch (assertion.type) {
    case "contains":
      return evidence.messages.some((reply) => reply.text !== undefined && includes(reply.text, assertion.text));
    case "notContains":
      return evidence.messages.every((reply) => reply.text === undefined || !includes(reply.text, assertion.text));
    case "matches":
      for (const reply of evidence.messages) {
        if (
          reply.text !== undefined &&
          (await ports.matches({ text: reply.text, pattern: assertion.pattern, flags: assertion.flags }))
        )
          return true;
      }
      return false;
    case "judge":
      return ports.judge({ rubric: assertion.rubric, replies: evidence.messages });
    case "grounded":
      return ports.judge({ rubric: GROUNDED_RUBRIC, replies: evidence.messages, passages: evidence.passages });
    case "toolCalled":
      for (const call of evidence.calls) {
        if (call.name !== assertion.name) continue;
        let matched = true;
        for (const [key, matcher] of Object.entries(assertion.input ?? {})) {
          if (!(await matchValue(own(call.input, key), matcher, ports))) {
            matched = false;
            break;
          }
        }
        if (matched) return true;
      }
      return false;
    case "toolNotCalled":
      return evidence.calls.every((call) => call.name !== assertion.name);
    case "toolOrder":
      return ordered(assertion.names, evidence.calls);
    case "reachedNode":
      return evidence.nodeNames.includes(assertion.node);
    case "exitTaken":
      return evidence.exits.includes(assertion.exit);
    case "variable":
      return matchValue(own(evidence.variables, assertion.variable), assertion.is, ports);
    case "handoffRequested":
      return evidence.handoffRequested === assertion.expected;
    case "messageType":
      return evidence.messages.some((reply) => reply.type === assertion.messageType);
    case "citesDocument":
      return evidence.messages.some((reply) => reply.citationTitles.some((title) => includes(title, assertion.title)));
    case "maxLatencyMs":
      return evidence.latencyMs <= assertion.value;
  }
}

/** Evaluate assertions in script order, passing infrastructure errors to the case runner. */
export async function assertTurn(
  turn: Pick<EvalTurn, "assert">,
  evidence: TurnEvidence,
  ports: AssertionPorts,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of turn.assert) {
    const outcome = await evaluate(assertion, evidence, ports);
    if (typeof outcome === "boolean") results.push({ assertion, passed: outcome });
    else results.push({ assertion, passed: outcome.passed, ...(outcome.reason ? { detail: outcome.reason } : {}) });
  }
  return results;
}
