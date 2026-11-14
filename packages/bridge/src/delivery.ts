import { z } from "zod";

/**
 * Sends one webhook request through egress (ADR-020: `POST /v1/fetch`; ADR-028 §7). Used by the
 * delivery worker and by the API's connection test (ADR-029 §4). Both are platform services, so they
 * authenticate with the shared egress token and name the workspace whose rate limit the request
 * counts against.
 */

/** Success is a 2xx within 10 s (§9.2). */
export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookRequest {
  workspaceId: string;
  url: string;
  headers: Record<string, string>;
  /** The exact bytes that were signed. */
  body: string;
}

export type SendResult =
  /** The receiver answered (any status; the caller decides what counts as success). */
  | { kind: "response"; status: number }
  /** Egress refused or could not complete the request. */
  | { kind: "refused"; code: "fetch_blocked" | "fetch_failed" | "rate_limited"; detail?: string };

export interface WebhookSender {
  send(request: WebhookRequest): Promise<SendResult>;
}

const FetchResult = z.object({ status: z.int().min(100).max(599) });
const Problem = z.object({ code: z.string(), detail: z.string().optional() });
const PASSED_THROUGH = new Set(["fetch_blocked", "fetch_failed", "rate_limited"]);

const failed = (detail: string): SendResult => ({ kind: "refused", code: "fetch_failed", detail });

/** The production sender. Never rejects: every failure is a `refused` result. */
export function egressSender(options: { egressUrl: string; egressToken: string }): WebhookSender {
  const endpoint = new URL("/v1/fetch", options.egressUrl);
  return {
    async send(request) {
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.egressToken}` },
          body: JSON.stringify({
            workspaceId: request.workspaceId,
            url: request.url,
            method: "POST",
            headers: request.headers,
            body: request.body,
            // A signed body is never forwarded to an address the builder did not configure.
            redirect: "manual",
            timeoutMs: WEBHOOK_TIMEOUT_MS,
          }),
          // Egress enforces the 10 s itself; this only covers egress not answering.
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS + 2_000),
        });
      } catch {
        return failed("the egress service could not be reached");
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return failed("the egress service sent an answer that could not be read");
      }
      if (res.status === 200) {
        const result = FetchResult.safeParse(payload);
        return result.success
          ? { kind: "response", status: result.data.status }
          : failed("the egress service sent an answer that could not be read");
      }
      const problem = Problem.safeParse(payload);
      if (!problem.success) return failed(`the egress service answered with status ${res.status}`);
      const { code, detail } = problem.data;
      if (!PASSED_THROUGH.has(code)) return failed(`egress refused the request: ${code}`);
      return {
        kind: "refused",
        code: code as "fetch_blocked" | "fetch_failed" | "rate_limited",
        ...(detail ? { detail } : {}),
      };
    },
  };
}
