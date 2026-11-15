import { z } from "zod";
import { BotId, ConversationId, Json, TurnId } from "./common";

export const UsageKind = z.enum([
  "conversation",
  "llm_tokens",
  "embedding_tokens",
  "rerank_units",
  "code_ms",
  "kb_storage_bytes",
  "table_rows",
  "webhook_deliveries",
]);
export const UsageMode = z.enum(["live", "emulator", "eval"]);
export const NewUsage = z
  .object({
    kind: UsageKind,
    quantity: z.number().finite().nonnegative(),
    unit: z.enum(["conversations", "tokens", "units", "ms", "bytes", "rows", "deliveries"]),
    model: z.string().optional(),
    costMicroUsd: z.number().int().nonnegative().default(0),
    mode: UsageMode,
    botId: BotId.optional(),
    conversationId: ConversationId.optional(),
    turnId: TurnId.optional(),
    detail: z.record(z.string(), Json).default({}),
    sourceKey: z.string().min(1).max(500).optional(),
  })
  .refine(
    (event) =>
      event.unit ===
      {
        conversation: "conversations",
        llm_tokens: "tokens",
        embedding_tokens: "tokens",
        rerank_units: "units",
        code_ms: "ms",
        kb_storage_bytes: "bytes",
        table_rows: "rows",
        webhook_deliveries: "deliveries",
      }[event.kind],
    { message: "Use the unit defined for this usage kind", path: ["unit"] },
  );
export type NewUsage = z.infer<typeof NewUsage>;
