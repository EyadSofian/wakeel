import { EGRESS_LIMITS } from "@wakeel/config";
import { WorkspaceId } from "@wakeel/contracts";
import { z } from "zod";

/**
 * Wire format of `POST /v1/fetch` (ADR-020, proposed). It lives here until a caller exists
 * (sandbox 3.3, webhook delivery 5.2); ADR-020 proposes moving it to `packages/contracts`.
 */

/** RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** No CR, LF or NUL: a header value cannot start another header. */
const HEADER_VALUE = /^[^\r\n\0]*$/;

export const FETCH_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export const FetchRequest = z
  .strictObject({
    /** Whose rate limit this request counts against, and whose it is in the log. */
    workspaceId: WorkspaceId,
    url: z.string().min(1).max(8192),
    method: z.enum(FETCH_METHODS).default("GET"),
    headers: z.record(z.string().regex(HEADER_NAME).max(256), z.string().regex(HEADER_VALUE).max(8192)).default({}),
    body: z.string().optional(),
    bodyEncoding: z.enum(["utf8", "base64"]).default("utf8"),
    redirect: z.enum(["follow", "manual"]).default("follow"),
    timeoutMs: z.int().min(1).max(EGRESS_LIMITS.timeoutMs).optional(),
    maxResponseBytes: z.int().min(0).max(EGRESS_LIMITS.responseBytes).optional(),
  })
  .refine((r) => r.body === undefined || (r.method !== "GET" && r.method !== "HEAD"), {
    path: ["body"],
    message: "GET and HEAD requests cannot have a body",
  });
export type FetchRequest = z.infer<typeof FetchRequest>;

export const FetchResult = z.object({
  status: z.int().min(100).max(599),
  statusText: z.string(),
  /** In the order received; repeated headers such as set-cookie stay separate. Names are lower-case. */
  headers: z.array(z.tuple([z.string(), z.string()])),
  /** Base64 of the decoded body. */
  body: z.string(),
  /** The URL that answered, after redirects. */
  url: z.string(),
  redirected: z.boolean(),
});
export type FetchResult = z.infer<typeof FetchResult>;
