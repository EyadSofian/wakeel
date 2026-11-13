import { z } from "zod";
import { ChunkId, ConversationId, DocumentId, HttpUrl, IsoDateTime, Json, MessageId, TurnId } from "./common";

/**
 * Message payloads. The same shapes are used:
 *  - on the Bridge API (final text), and
 *  - inside card definitions (string fields may contain `{{ }}` templates, rendered before sending).
 * Every user-visible string is non-empty: an empty `text` is a validation error, never a runtime crash.
 */

const Text = z.string().min(1).max(8_000);
const Label = z.string().min(1).max(80);

export const Option = z.object({
  label: Label,
  /** Sent back as a `postback` when the user picks this option. */
  value: z.string().min(1).max(500),
});
export type Option = z.infer<typeof Option>;

export const TextMessage = z.object({
  type: z.literal("text"),
  text: Text,
  format: z.enum(["markdown", "plain"]).default("markdown"),
});

export const ImageMessage = z.object({
  type: z.literal("image"),
  url: HttpUrl,
  alt: z.string().max(300).optional(),
  caption: Text.optional(),
});

export const FileMessage = z.object({
  type: z.literal("file"),
  url: HttpUrl,
  name: z.string().min(1).max(255),
  mime: z.string().max(127).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const LocationMessage = z.object({
  type: z.literal("location"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  title: z.string().max(120).optional(),
  address: z.string().max(300).optional(),
});

/** Buttons. Bridges that cannot render buttons should fall back to a numbered list. */
export const ChoiceMessage = z.object({
  type: z.literal("choice"),
  text: Text,
  options: z.array(Option).min(1).max(20),
});

export const DropdownMessage = z.object({
  type: z.literal("dropdown"),
  text: Text,
  placeholder: z.string().max(80).optional(),
  options: z.array(Option).min(1).max(100),
});

export const CardAction = z.object({
  type: z.enum(["postback", "url", "say"]),
  label: Label,
  /** postback: value returned to the bot · url: link to open · say: text sent as the user. */
  value: z.string().min(1).max(2_000),
});

export const CardBody = z.object({
  title: z.string().min(1).max(120),
  subtitle: z.string().max(300).optional(),
  imageUrl: HttpUrl.optional(),
  actions: z.array(CardAction).max(5).default([]),
});

export const CardMessage = CardBody.extend({ type: z.literal("card") });

export const CarouselMessage = z.object({
  type: z.literal("carousel"),
  items: z.array(CardBody).min(1).max(10),
});

/** Escape hatch for bridge-specific content. `name` tells the bridge how to interpret `data`. */
export const CustomMessage = z.object({
  type: z.literal("custom"),
  name: z.string().min(1).max(64),
  data: Json,
});

/** What the bot can send. */
export const BotMessagePayload = z.discriminatedUnion("type", [
  TextMessage,
  ImageMessage,
  FileMessage,
  LocationMessage,
  ChoiceMessage,
  DropdownMessage,
  CardMessage,
  CarouselMessage,
  CustomMessage,
]);
export type BotMessagePayload = z.infer<typeof BotMessagePayload>;

/** A button, dropdown or card action the user picked. */
export const PostbackMessage = z.object({
  type: z.literal("postback"),
  value: z.string().min(1).max(500),
  /** The label the user saw; used as transcript text. */
  label: z.string().max(80).optional(),
});

/** What a user can send through a bridge. */
export const UserMessagePayload = z.discriminatedUnion("type", [
  TextMessage.extend({ text: z.string().min(1).max(16_000) }),
  ImageMessage,
  FileMessage,
  LocationMessage,
  PostbackMessage,
  CustomMessage,
]);
export type UserMessagePayload = z.infer<typeof UserMessagePayload>;

export const Citation = z.object({
  /** 1-based index as rendered to the user. */
  index: z.number().int().positive(),
  documentId: DocumentId,
  chunkId: ChunkId,
  title: z.string(),
  uri: z.string().optional(),
  snippet: z.string().max(500).optional(),
});
export type Citation = z.infer<typeof Citation>;

/** A stored message as returned by the APIs and carried in `message.created` events. */
export const Message = z.object({
  id: MessageId,
  conversationId: ConversationId,
  /** Position in the conversation transcript; strictly increasing. */
  seq: z.number().int().nonnegative(),
  direction: z.enum(["in", "out"]),
  payload: z.union([BotMessagePayload, UserMessagePayload]),
  citations: z.array(Citation).default([]),
  turnId: TurnId.optional(),
  /** The bridge's own id for an inbound message, if it sent one. */
  externalId: z.string().max(255).optional(),
  createdAt: IsoDateTime,
});
export type Message = z.infer<typeof Message>;

export const BOT_MESSAGE_TYPES = [
  "text",
  "image",
  "file",
  "location",
  "choice",
  "dropdown",
  "card",
  "carousel",
  "custom",
] as const;
