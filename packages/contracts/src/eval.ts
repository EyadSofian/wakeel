import { z } from "zod";
import {
  ConversationId,
  DisplayName,
  EvalCaseId,
  EvalRunId,
  EvalSuiteId,
  IsoDateTime,
  Json,
  TurnId,
  VersionId,
} from "./common";
import { UserData } from "./event";

const Matcher = z.union([
  z.object({ equals: Json }),
  z.object({ contains: z.string() }),
  z.object({ matches: z.string() }),
  z.object({ exists: z.boolean() }),
]);

export const Assertion = z.discriminatedUnion("type", [
  /** Any bot message in the turn contains this text (case-insensitive, after Arabic normalisation). */
  z.object({ type: z.literal("contains"), text: z.string().min(1) }),
  z.object({ type: z.literal("notContains"), text: z.string().min(1) }),
  z.object({ type: z.literal("matches"), pattern: z.string().min(1), flags: z.string().max(4).default("iu") }),
  /** The utility model judges the turn's replies against this rubric; passes on a yes. */
  z.object({ type: z.literal("judge"), rubric: z.string().min(1).max(2_000) }),
  /**
   * The utility model checks every factual claim in the turn's replies against the passages the turn
   * retrieved; passes when all are supported or the reply says it does not know (ADR-056 G2).
   */
  z.object({ type: z.literal("grounded") }),
  z.object({ type: z.literal("toolCalled"), name: z.string(), input: z.record(z.string(), Matcher).optional() }),
  z.object({ type: z.literal("toolNotCalled"), name: z.string() }),
  z.object({ type: z.literal("toolOrder"), names: z.array(z.string()).min(2) }),
  /** A node with this name was entered during the turn. */
  z.object({ type: z.literal("reachedNode"), node: z.string() }),
  z.object({ type: z.literal("exitTaken"), exit: z.string() }),
  /** `variable` is `<scope>.<name>`. */
  z.object({ type: z.literal("variable"), variable: z.string(), is: Matcher }),
  z.object({ type: z.literal("handoffRequested"), expected: z.boolean().default(true) }),
  z.object({ type: z.literal("messageType"), messageType: z.string() }),
  /** A reply cites a document whose title contains this text. */
  z.object({ type: z.literal("citesDocument"), title: z.string() }),
  z.object({ type: z.literal("maxLatencyMs"), value: z.number().int().positive() }),
]);
export type Assertion = z.infer<typeof Assertion>;

export const EvalTurn = z
  .object({
    /** Send this as the user. */
    user: z.string().optional(),
    /** Or pick an option by value. */
    postback: z.string().optional(),
    /** Or fire a custom event. */
    event: z.object({ name: z.string(), payload: z.record(z.string(), Json).default({}) }).optional(),
    /** Start a fresh conversation for the same user before this turn. */
    newConversation: z.boolean().default(false),
    /** The bot must send nothing. */
    expectSilence: z.boolean().default(false),
    assert: z.array(Assertion).default([]),
  })
  .refine((t) => [t.user, t.postback, t.event].filter((x) => x !== undefined).length === 1, {
    message: "Each turn needs exactly one of: user, postback, event",
  });
export type EvalTurn = z.infer<typeof EvalTurn>;

export const EvalCase = z.object({
  name: DisplayName,
  description: z.string().max(1_000).optional(),
  /** Tags such as `ar-EG`, `code-switch`, `kb`, `handoff`; used for filtering and per-language scores. */
  tags: z.array(z.string().max(32)).max(10).default([]),
  /** A case that must pass for the suite to meet the task-success gate (ADR-056 G4). */
  critical: z.boolean().default(false),
  /** User data applied before the first turn. */
  user: UserData.optional(),
  turns: z.array(EvalTurn).min(1).max(50),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalTurnResult = z.object({
  index: z.number().int().nonnegative(),
  turnId: z.string().optional(),
  conversationId: ConversationId.optional(),
  silencePassed: z.boolean().optional(),
  assertions: z.array(z.object({ assertion: Assertion, passed: z.boolean(), detail: z.string().optional() })),
  /** The whole turn, from its trace (ADR-056 G5). */
  latencyMs: z.number().int().nonnegative().optional(),
  /** From the turn's start to its first committed bot message: when the user starts reading (G5). */
  firstMessageMs: z.number().int().nonnegative().optional(),
  /** What the turn's model calls cost, from its `llm.call` spans (G6). */
  costMicroUsd: z.number().int().nonnegative().optional(),
});
export type EvalTurnResult = z.infer<typeof EvalTurnResult>;
export const EvalResult = z.object({
  status: z.enum(["passed", "failed", "error"]),
  turns: z.array(EvalTurnResult),
  conversationId: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().optional(),
});
export type EvalResult = z.infer<typeof EvalResult>;

export const EvalTarget = z.union([
  z.strictObject({ kind: z.literal("draft") }),
  z.strictObject({ kind: z.literal("version"), versionId: VersionId }),
]);
export type EvalTarget = z.infer<typeof EvalTarget>;
export const NewEvalSuite = z.strictObject({ name: DisplayName });
export const EvalSuite = NewEvalSuite.extend({ id: EvalSuiteId, revision: z.number().int().positive() });
export const EvalCaseEntry = z.object({ id: EvalCaseId, script: EvalCase, revision: z.number().int().positive() });
export const EvalRun = z.object({
  id: EvalRunId,
  suiteId: EvalSuiteId,
  target: EvalTarget,
  status: z.enum(["queued", "running", "passed", "failed", "error"]),
  createdAt: IsoDateTime,
});
export const EvalRunDetail = EvalRun.extend({
  cases: z.array(EvalCaseEntry),
  results: z.array(z.object({ caseId: EvalCaseId, result: EvalResult })),
});
export const EvalTurnReceipt = z.object({ conversationId: ConversationId, turnId: TurnId });
export const EvalPublishStatus = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

/**
 * Human-labelled judge cases for one suite (ADR-056 G7). The gate runs the judge on each and reports
 * agreement; the judge's scores count only at 90% or more over at least 50 cases.
 */
export const JudgeCalibration = z.object({
  items: z
    .array(
      z.object({
        assertion: z.union([
          z.object({ type: z.literal("judge"), rubric: z.string().min(1).max(2_000) }),
          z.object({ type: z.literal("grounded") }),
        ]),
        replies: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              citationTitles: z.array(z.string()).default([]),
            }),
          )
          .min(1),
        /** The passages the judge sees for `grounded`. */
        passages: z.array(z.object({ title: z.string(), text: z.string() })).default([]),
        /** The person's verdict. */
        human: z.enum(["pass", "fail"]),
      }),
    )
    .max(1_000),
});
export type JudgeCalibration = z.infer<typeof JudgeCalibration>;
