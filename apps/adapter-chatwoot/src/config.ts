import { z } from "zod";

/**
 * One (Chatwoot account + agent bot) ↔ (bridge connection) pair (chatwoot-adapter-spec §1). Pairs come
 * from the `ADAPTER_PAIRS` environment variable as JSON, because every field but the slug is a
 * credential or routing detail that belongs to the deployment, not to the repository.
 */
export const Pair = z.object({
  /** Random slug; appears in both webhook URLs, so it also authenticates Chatwoot's webhook. */
  id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Use 16–64 URL-safe characters"),
  chatwootBaseUrl: z.url().transform((u) => u.replace(/\/+$/, "")),
  chatwootAccountId: z.number().int().positive(),
  /** Sent as `api_access_token`: the agent bot's token, or an agent token with access to the inbox. */
  chatwootToken: z.string().min(1),
  /** Origin of the platform's public API, without `/v1`. */
  bridgeBaseUrl: z.url().transform((u) => u.replace(/\/+$/, "")),
  bridgeKey: z.string().regex(/^wk_bridge_/, "A bridge key starts with wk_bridge_"),
  /** Active signing secrets, newest first; two during a rotation. */
  bridgeSigningSecrets: z.array(z.string().min(1)).min(1).max(2),
  handoffTeamId: z.number().int().positive().optional(),
  handoffAssigneeId: z.number().int().positive().optional(),
  /** Send `conversation_started` when Chatwoot opens a conversation, so the bot can greet first. */
  greetFirst: z.boolean().default(false),
  /** Resolve the Chatwoot conversation when the bot ends it as completed. */
  autoResolve: z.boolean().default(false),
  /** Channels that render `input_select`; others get a numbered list (spec §4). */
  selectChannels: z.array(z.string()).default(["Channel::WebWidget", "Channel::Api"]),
});
export type Pair = z.infer<typeof Pair>;

export const AdapterConfig = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(4600),
  host: z.string().default("::"),
  redisUrl: z.string().optional(),
  pairs: z.array(Pair).min(1),
});
export type AdapterConfig = z.infer<typeof AdapterConfig>;

/** Reads the adapter's configuration; throws with the offending path, never with a value. */
export function loadConfig(env: NodeJS.ProcessEnv): AdapterConfig {
  let pairs: unknown;
  try {
    pairs = JSON.parse(env["ADAPTER_PAIRS"] ?? "");
  } catch {
    throw new Error("ADAPTER_PAIRS must be a JSON array of pairs (see apps/adapter-chatwoot/README.md)");
  }
  const parsed = AdapterConfig.safeParse({
    port: env["PORT"],
    host: env["ADAPTER_HOST"],
    redisUrl: env["REDIS_URL"] || undefined,
    pairs,
  });
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid adapter configuration: ${where}`);
  }
  return parsed.data;
}
