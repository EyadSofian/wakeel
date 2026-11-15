import { AppError, Problem } from "@wakeel/contracts";
import type { HttpGet, HttpResponse } from "@wakeel/retrieval";
import { z } from "zod";

/**
 * GET through the egress service (ADR-020): the only way the crawler and URL sources reach a
 * tenant-supplied address. Egress resolves DNS, blocks private ranges on every redirect hop, caps the
 * body at 5 MB and rate-limits per workspace; this client only speaks its protocol.
 */
const FetchResult = z.object({
  status: z.int().min(100).max(599),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
  url: z.string(),
});

const TIMEOUT_MS = 10_000;

export function egressGet(options: { egressUrl: string; egressToken: string; workspaceId: string }): HttpGet {
  const endpoint = new URL("/v1/fetch", options.egressUrl);
  return async (url, headers) => {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.egressToken}` },
        body: JSON.stringify({
          workspaceId: options.workspaceId,
          url,
          method: "GET",
          headers,
          redirect: "follow",
          timeoutMs: TIMEOUT_MS,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS + 2_000),
      });
    } catch (e) {
      throw new AppError(
        "source_fetch_failed",
        { url, message: "the egress service could not be reached" },
        { cause: e },
      );
    }
    const payload: unknown = await res.json().catch(() => undefined);
    if (res.status !== 200) {
      const problem = Problem.safeParse(payload);
      const message = problem.success ? problem.data.title : `egress answered ${res.status}`;
      throw new AppError("source_fetch_failed", { url, message });
    }
    const r = FetchResult.parse(payload);
    const out: HttpResponse = {
      status: r.status,
      headers: Object.fromEntries(r.headers.map(([k, v]) => [k.toLowerCase(), v])),
      body: Uint8Array.from(Buffer.from(r.body, "base64")),
      url: r.url,
    };
    return out;
  };
}

/** The type the pipeline parses a page as: the response's media type without parameters. */
export function mimeOf(res: HttpResponse): string {
  return (res.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim().toLowerCase() ?? "";
}
