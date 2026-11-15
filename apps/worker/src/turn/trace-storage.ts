import { createHash } from "node:crypto";
import type { Span } from "@wakeel/contracts";
import { type Database, type ObjectStore, upsertSpans } from "@wakeel/db";
import { prepareTraceSpan, tracePreviewOnly } from "@wakeel/telemetry";
import { scrubSecrets } from "./redact";

/** The worker hands both database and object storage the same already-redacted span. */
export async function storeTraceSpans(
  db: Database,
  store: Pick<ObjectStore, "put">,
  workspaceId: string,
  spans: readonly Span[],
  secrets: readonly string[],
  patterns: readonly RegExp[],
  failedUpload: () => void,
) {
  const keys = new Map<string, string>();
  const safe: Span[] = [];
  const signal = AbortSignal.timeout(2000);
  for (const original of spans) {
    const { span, bundle } = prepareTraceSpan(original, (value, keys) => scrubSecrets(value, secrets, patterns, keys));
    if (!Object.keys(bundle).length) {
      safe.push(span);
      continue;
    }
    const body = Buffer.from(JSON.stringify(bundle));
    const tag = createHash("sha256").update(body).digest("hex");
    const key = `traces/${workspaceId}/${span.id}/${tag}.json`;
    try {
      signal.throwIfAborted();
      await store.put(key, body, "application/json", { signal });
      keys.set(span.id, key);
      safe.push(span);
    } catch {
      failedUpload();
      safe.push(tracePreviewOnly(span));
    }
  }
  await db.withWorkspace(workspaceId, (tx) => upsertSpans(tx, safe, keys));
}
