import { z } from "zod";
import { DisplayName, Json } from "./common";
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
  /** User data applied before the first turn. */
  user: UserData.optional(),
  turns: z.array(EvalTurn).min(1).max(50),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalResult = z.object({
  status: z.enum(["passed", "failed", "error"]),
  turns: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      turnId: z.string().optional(),
      assertions: z.array(z.object({ assertion: Assertion, passed: z.boolean(), detail: z.string().optional() })),
    }),
  ),
  conversationId: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});
export type EvalResult = z.infer<typeof EvalResult>;
