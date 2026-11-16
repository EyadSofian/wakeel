import type { SendMessageRequest, UserData } from "@wakeel/contracts";
import { z } from "zod";
import type { BridgeClient } from "./bridge";
import type { ChatwootClient } from "./chatwoot";
import type { Pair } from "./config";
import { DAY_SECONDS, type Store } from "./store";

/**
 * Chatwoot → platform (chatwoot-adapter-spec §3). Agent-bot webhook payloads are loosely typed and
 * differ between events, so only the fields used are read, each optional, and anything unexpected
 * is ignored rather than failing the webhook.
 */

const Sender = z
  .object({
    id: z.number().optional(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    phone_number: z.string().nullish(),
    type: z.string().nullish(),
    custom_attributes: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();

const Attachment = z
  .object({
    id: z.number().optional(),
    file_type: z.string().nullish(),
    data_url: z.string().nullish(),
    coordinates_lat: z.number().nullish(),
    coordinates_long: z.number().nullish(),
    fallback_title: z.string().nullish(),
  })
  .loose();

const Conversation = z
  .object({
    id: z.number(),
    status: z.string().nullish(),
    channel: z.string().nullish(),
    inbox_id: z.number().nullish(),
    meta: z.object({ sender: Sender.nullish() }).loose().nullish(),
  })
  .loose();

export const ChatwootWebhook = z
  .object({
    event: z.string(),
    id: z.number().optional(),
    content: z.string().nullish(),
    message_type: z.union([z.string(), z.number()]).nullish(),
    content_type: z.string().nullish(),
    content_attributes: z.record(z.string(), z.unknown()).nullish(),
    private: z.boolean().nullish(),
    status: z.string().nullish(),
    sender: Sender.nullish(),
    attachments: z.array(Attachment).nullish(),
    conversation: Conversation.nullish(),
    inbox: z.object({ id: z.number().optional() }).loose().nullish(),
    changed_attributes: z.array(z.record(z.string(), z.unknown())).nullish(),
  })
  .loose();
export type ChatwootWebhook = z.infer<typeof ChatwootWebhook>;

export const externalConversationId = (pair: Pair, conversationId: number) =>
  `cw-${pair.chatwootAccountId}-${conversationId}`;
export const externalUserId = (pair: Pair, contactId: number) => `cw-${pair.chatwootAccountId}-contact-${contactId}`;
export const numberedKey = (pair: Pair, conversationId: number) => `numbered:${pair.id}:${conversationId}`;
/** The conversation's Chatwoot channel, remembered so replies know whether buttons render. */
export const channelKey = (pair: Pair, conversationId: number) => `channel:${pair.id}:${conversationId}`;

const EMAIL = z.email();
const isIncoming = (t: ChatwootWebhook["message_type"]) => t === "incoming" || t === 0;

/** Western and Arabic-Indic digits: a reply of just "٢" picks option 2 the same as "2". */
function parseChoiceNumber(text: string): number | undefined {
  const western = text.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  return /^\d{1,2}$/.test(western) ? Number(western) : undefined;
}

function userData(sender: z.infer<typeof Sender>, conversation: z.infer<typeof Conversation>, inboxId?: number) {
  const attributes: Record<string, unknown> = {
    ...(sender.custom_attributes ?? {}),
    chatwootContactId: sender.id ?? null,
    chatwootConversationId: conversation.id,
    inboxId: inboxId ?? conversation.inbox_id ?? null,
    channel: conversation.channel ?? null,
  };
  const user: UserData = {
    ...(sender.name ? { name: sender.name.slice(0, 200) } : {}),
    ...(sender.email && EMAIL.safeParse(sender.email).success ? { email: sender.email } : {}),
    ...(sender.phone_number ? { phone: sender.phone_number.slice(0, 40) } : {}),
    attributes: attributes as UserData["attributes"],
  };
  return user;
}

export interface InboundDeps {
  pair: Pair;
  bridge: BridgeClient;
  chatwoot: ChatwootClient;
  store: Store;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}

/** Handles one Chatwoot webhook. Called after the webhook has been acknowledged. */
export async function handleChatwootWebhook(deps: InboundDeps, raw: unknown): Promise<void> {
  const parsed = ChatwootWebhook.safeParse(raw);
  if (!parsed.success) {
    deps.log("warn", "Ignored a Chatwoot webhook that does not match the expected shape", {
      issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")),
    });
    return;
  }
  const hook = parsed.data;
  switch (hook.event) {
    case "message_created":
    case "message_updated":
      return onMessage(deps, hook);
    case "conversation_status_changed":
      return onStatusChanged(deps, hook);
    case "conversation_created":
    case "webwidget_triggered":
      return onConversationOpened(deps, hook);
    default:
      return;
  }
}

async function onMessage(deps: InboundDeps, hook: ChatwootWebhook): Promise<void> {
  const { pair, bridge, store } = deps;
  const conversation = hook.conversation;
  if (!conversation || hook.id === undefined) return;
  const ext = externalConversationId(pair, conversation.id);
  if (conversation.channel) await store.setJson(channelKey(pair, conversation.id), conversation.channel, DAY_SECONDS);

  // A picked `input_select` option: Chatwoot records it on the bot's message as submitted_values.
  const submitted = z
    .array(z.object({ value: z.string().min(1), title: z.string().optional() }).loose())
    .safeParse(hook.content_attributes?.["submitted_values"]);
  if (submitted.success && submitted.data[0]) {
    const sender = conversation.meta?.sender ?? hook.sender;
    if (!sender?.id) return;
    const pick = submitted.data[0];
    await bridge.sendMessage(
      ext,
      {
        userId: externalUserId(pair, sender.id),
        user: userData(sender, conversation, hook.inbox?.id),
        message: { type: "postback", value: pick.value, ...(pick.title ? { label: pick.title.slice(0, 80) } : {}) },
        externalMessageId: `cw-sel-${hook.id}`,
      },
      `cw-sel-${hook.id}`,
    );
    return;
  }

  if (hook.event !== "message_created" || !isIncoming(hook.message_type) || hook.private) return;
  const sender = hook.sender;
  if (!sender?.id || (sender.type && sender.type !== "contact")) return;

  const base = {
    userId: externalUserId(pair, sender.id),
    user: userData(sender, conversation, hook.inbox?.id),
    metadata: { chatwootStatus: conversation.status ?? null },
  } satisfies Omit<SendMessageRequest, "message">;
  const parts: { message: SendMessageRequest["message"]; suffix: string }[] = [];

  const text = (hook.content ?? "").trim();
  if (text) {
    const n = parseChoiceNumber(text);
    const numbered = n === undefined ? undefined : await store.getJson<string[]>(numberedKey(pair, conversation.id));
    const value = n === undefined ? undefined : numbered?.[n - 1];
    parts.push({
      message: value
        ? { type: "postback", value, label: text.slice(0, 80) }
        : { type: "text", text: text.slice(0, 16_000), format: "plain" },
      suffix: "",
    });
  }
  for (const [i, a] of (hook.attachments ?? []).entries()) {
    const suffix = `-a${a.id ?? i}`;
    if (a.file_type === "location" && a.coordinates_lat != null && a.coordinates_long != null) {
      parts.push({ message: { type: "location", latitude: a.coordinates_lat, longitude: a.coordinates_long }, suffix });
    } else if (a.data_url && /^https?:\/\//.test(a.data_url)) {
      parts.push({
        message:
          a.file_type === "image"
            ? { type: "image", url: a.data_url }
            : { type: "file", url: a.data_url, name: (a.fallback_title || `attachment-${a.id ?? i}`).slice(0, 255) },
        suffix,
      });
    }
  }
  // Text first, then each attachment, each with its own idempotency key (spec §3).
  for (const part of parts) {
    const key = `cw-msg-${hook.id}${part.suffix}`;
    await bridge.sendMessage(ext, { ...base, message: part.message, externalMessageId: key }, key);
  }
}

async function onStatusChanged(deps: InboundDeps, hook: ChatwootWebhook): Promise<void> {
  // Conversation events carry the conversation itself at the top level.
  const conversationId = hook.conversation?.id ?? hook.id;
  if (conversationId === undefined) return;
  const ext = externalConversationId(deps.pair, conversationId);
  const status = hook.status ?? hook.conversation?.status;
  if (status === "pending") await deps.bridge.releaseHandoff(ext);
  else if (status === "resolved") await deps.bridge.endConversation(ext);
}

async function onConversationOpened(deps: InboundDeps, hook: ChatwootWebhook): Promise<void> {
  if (!deps.pair.greetFirst) return;
  const conversation = hook.conversation ?? (hook.id !== undefined ? { id: hook.id } : undefined);
  const sender = hook.conversation?.meta?.sender ?? hook.sender;
  if (!conversation || !sender?.id) return;
  if (!(await deps.store.claim(`greeted:${deps.pair.id}:${conversation.id}`, DAY_SECONDS))) return;
  await deps.bridge.sendEvent(externalConversationId(deps.pair, conversation.id), {
    userId: externalUserId(deps.pair, sender.id),
    user: userData(sender, Conversation.parse({ ...conversation }), hook.inbox?.id),
    name: "conversation_started",
    payload: {},
  });
}
