import type { StepLog } from "../ports";
import { CardEvaluator } from "./render";
import type { ExecutorOf } from "./types";

/** Log: writes a line, and optionally a data value, to the conversation log and the trace. */
export const log: ExecutorOf<"log"> = async (ctx) => {
  const ev = new CardEvaluator();
  const message = ev.template(ctx.card.message);
  const data = ctx.card.data === undefined ? undefined : ev.expression(ctx.card.data);
  const evaluated = await ev.run(ctx.scopes, ctx.sandbox);
  const line: StepLog = { level: ctx.card.level, message: evaluated.text(message) };
  if (data !== undefined) {
    const value = evaluated.value(data);
    if (value !== undefined) line.data = value;
  }
  return { outcome: { type: "next" }, logs: [line] };
};

/** End: ends the conversation with its rendered reason. */
export const end: ExecutorOf<"end"> = async (ctx) => {
  const ev = new CardEvaluator();
  const reason = ev.template(ctx.card.reason);
  const evaluated = await ev.run(ctx.scopes, ctx.sandbox);
  return { outcome: { type: "end", reason: evaluated.text(reason) } };
};

/** Set timeout: changes this conversation's inactivity timeout; 0 means it never expires. */
export const setTimeoutCard: ExecutorOf<"set_timeout"> = async (ctx) => ({
  outcome: { type: "next" },
  inactivityTimeoutMinutes: ctx.card.minutes,
});
