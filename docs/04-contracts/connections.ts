import { z } from "zod";
import { DisplayName, IsoDateTime } from "./common";
import { BRIDGE_EVENT_TYPES } from "./event";

/**
 * The Studio's connection management (task 5.5, ADR-030, design system §5.11). The Bridge API's own
 * shapes are in bridge.ts; these are what a builder's session sends and receives.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 ranges a webhook may never name directly: this host, private, CGNAT, link-local, metadata. */
function blockedIpv4(host: string): boolean {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** IPv6 literals (the URL keeps the brackets): loopback, unspecified, unique-local, link-local, mapped. */
function blockedIpv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const ip = host.slice(1, -1).toLowerCase();
  if (ip === "::1" || ip === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)) return true;
  // IPv4-mapped (::ffff:a.b.c.d, or the hex form the URL parser normalises it to).
  const mapped = /^::ffff:(.+)$/.exec(ip);
  if (mapped) {
    const tail = mapped[1] as string;
    if (IPV4.test(tail)) return blockedIpv4(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = Number.parseInt(hex[1] as string, 16);
      const lo = Number.parseInt(hex[2] as string, 16);
      return blockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  return false;
}

/**
 * Why a webhook URL is refused, or `undefined` when it is acceptable (ADR-030 §4). A convenience
 * for the builder: egress checks every request again after resolving DNS (ADR-020).
 */
export function webhookUrlProblem(value: string): string | undefined {
  if (value.length > 2048) return "Use an address of at most 2048 characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full address, starting with https://";
  }
  if (url.protocol !== "https:") return "Use an https address";
  if (url.username || url.password) return "Remove the user name and password from the address";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "Use a public address, not localhost";
  if (blockedIpv4(host) || blockedIpv6(host)) return "Use a public address, not a private or local one";
  return undefined;
}

export const WebhookUrl = z.string().superRefine((value, ctx) => {
  const problem = webhookUrlProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const SubscribedEvents = z
  .array(z.enum(BRIDGE_EVENT_TYPES as [string, ...string[]]))
  .max(BRIDGE_EVENT_TYPES.length)
  .transform((events) => [...new Set(events)]);

export const CreateConnectionRequest = z.object({
  name: DisplayName,
  target: z.enum(["production", "draft"]),
  webhookUrl: WebhookUrl.optional(),
  subscribedEvents: SubscribedEvents.default([...BRIDGE_EVENT_TYPES]),
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

export const UpdateConnectionRequest = z
  .object({
    name: DisplayName.optional(),
    target: z.enum(["production", "draft"]).optional(),
    /** `null` removes the webhook. */
    webhookUrl: WebhookUrl.nullable().optional(),
    subscribedEvents: SubscribedEvents.optional(),
    /** `active` also turns a disabled connection back on (ADR-030 §1). */
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Change at least one field" });
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;

/** A connection as the Studio shows it. Secrets appear only as their last four characters. */
export const StudioConnection = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  target: z.enum(["production", "draft"]),
  status: z.enum(["active", "paused", "disabled"]),
  webhookUrl: z.string().nullable(),
  subscribedEvents: z.array(z.string()),
  /** Newest first; two during a rotation. */
  signingSecrets: z.array(z.object({ last4: z.string().length(4) })),
  consecutiveDead: z.number().int().nonnegative(),
  lastDelivery: z.object({ status: z.enum(["delivered", "failed", "dead"]), at: IsoDateTime }).nullable(),
  createdAt: IsoDateTime,
});
export type StudioConnection = z.infer<typeof StudioConnection>;

/** `testWebhook` and the Studio's test button. */
export const WebhookTestResult = z.object({
  delivered: z.boolean(),
  statusCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  /** A code from errors.ts. */
  error: z.string().optional(),
});
export type WebhookTestResult = z.infer<typeof WebhookTestResult>;

export const TestMessageRequest = z.object({ text: z.string().min(1).max(4_000) });
export type TestMessageRequest = z.infer<typeof TestMessageRequest>;
