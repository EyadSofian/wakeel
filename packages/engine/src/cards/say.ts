import { renderMessages } from "./render";
import type { ExecutorOf } from "./types";

/** Say: sends one message, rendered and checked against the contract. */
export const say: ExecutorOf<"say"> = async (ctx) => {
  const messages = await renderMessages([ctx.card.message], ctx.scopes, ctx.sandbox);
  return { outcome: { type: "next" }, messages };
};
