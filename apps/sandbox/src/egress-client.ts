/**
 * The guest `fetch`, sent through egress (architecture §5.2, §5.3 layer 4; ADR-020; ADR-023 §4).
 * Runs on the pool's thread: runners make no network calls. The exec's capability token is the
 * only credential, and egress takes the workspace from it.
 *
 * The response schema is a copy of `apps/egress/src/protocol.ts` (apps may not import apps) until
 * both move to `packages/contracts` (ADR-020).
 */
import { EGRESS_LIMITS } from "@wakeel/config";
import { z } from "zod";
import type { CallAnswer, GuestFetchRequest } from "./guest/index.ts";

const FetchResult = z.object({
  status: z.int().min(100).max(599),
  statusText: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
  url: z.string(),
  redirected: z.boolean(),
});

/** Egress refusals the guest sees under their own code; anything else is `fetch_failed`. */
const PASSED_THROUGH = new Set([
  "fetch_blocked",
  "fetch_failed",
  "rate_limited",
  "validation_failed",
  "payload_too_large",
]);

export interface EgressCall {
  egressUrl: string | undefined;
  capabilityToken: string | undefined;
  request: GuestFetchRequest;
  /** Epoch ms; egress is asked to finish by then. */
  deadline: number;
  signal: AbortSignal;
}

const failed = (message: string): CallAnswer => ({ ok: false, code: "fetch_failed", message });

/** Never rejects: every failure is an answer the guest can catch. */
export async function fetchThroughEgress(call: EgressCall): Promise<CallAnswer> {
  if (!call.capabilityToken) return failed("this run has no network access");
  if (!call.egressUrl) return failed("the sandbox has no egress service configured");
  const timeoutMs = Math.min(EGRESS_LIMITS.timeoutMs, call.deadline - Date.now());
  if (timeoutMs < 1) return failed("the run's time limit was reached before the request was sent");

  const body: Record<string, unknown> = {
    url: call.request.url,
    method: call.request.method,
    headers: call.request.headers,
    timeoutMs,
  };
  if (call.request.body !== undefined) body["body"] = call.request.body;

  let res: Response;
  try {
    res = await fetch(new URL("/v1/fetch", call.egressUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Capability ${call.capabilityToken}` },
      body: JSON.stringify(body),
      // Egress has its own deadline; this one only covers egress itself not answering.
      signal: AbortSignal.any([call.signal, AbortSignal.timeout(timeoutMs + 1_000)]),
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
    if (!result.success) return failed("the egress service sent an answer that could not be read");
    const { status, statusText, headers, url } = result.data;
    return {
      ok: true,
      value: { status, statusText, headers, url, body: Buffer.from(result.data.body, "base64").toString("utf8") },
    };
  }

  const problem = (typeof payload === "object" && payload !== null ? payload : {}) as {
    code?: unknown;
    title?: unknown;
  };
  const code = typeof problem.code === "string" ? problem.code : "";
  if (code === "unauthenticated") return failed("egress refused this run's credentials");
  if (!PASSED_THROUGH.has(code)) return failed(`egress answered ${res.status}`);
  return { ok: false, code, message: typeof problem.title === "string" ? problem.title : code };
}
