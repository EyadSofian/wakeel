import type { SendEventRequest, SendMessageRequest } from "@wakeel/contracts";
import type { Pair } from "./config";
import { type HttpCall, UpstreamError } from "./http";

/** The public Bridge API calls the adapter makes. It has no other access to the platform. */
export interface BridgeClient {
  sendMessage(externalConversationId: string, body: SendMessageRequest, idempotencyKey: string): Promise<void>;
  sendEvent(externalConversationId: string, body: SendEventRequest): Promise<void>;
  releaseHandoff(externalConversationId: string, note?: string): Promise<void>;
  endConversation(externalConversationId: string): Promise<void>;
}

/** Attempts per Bridge call before the adapter gives up and alerts a human (spec §6). */
export const BRIDGE_ATTEMPTS = 5;

export function bridgeClient(pair: Pair, http: HttpCall, sleep: (ms: number) => Promise<void>): BridgeClient {
  const call = async (ext: string, action: string, body: unknown, extra: Record<string, string> = {}) => {
    const url = `${pair.bridgeBaseUrl}/v1/bridge/conversations/${encodeURIComponent(ext)}/${action}`;
    let last: UpstreamError | undefined;
    for (let attempt = 1; attempt <= BRIDGE_ATTEMPTS; attempt++) {
      let status = 0;
      try {
        status = (
          await http({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${pair.bridgeKey}`, ...extra },
            body,
            timeoutMs: 15_000,
          })
        ).status;
      } catch {
        status = 0;
      }
      // 409 not_handed_off: the conversation is already back with the bot; nothing to do.
      if ((status >= 200 && status < 300) || (status === 409 && action === "handoff/release")) return;
      last = new UpstreamError("bridge", status, action);
      if (!last.retryable) throw last;
      if (attempt < BRIDGE_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
    }
    throw last as UpstreamError;
  };
  return {
    sendMessage: (ext, body, key) => call(ext, "messages", body, { "idempotency-key": key }),
    sendEvent: (ext, body) => call(ext, "events", body),
    releaseHandoff: (ext, note) => call(ext, "handoff/release", note ? { note } : {}),
    endConversation: (ext) => call(ext, "end", {}),
  };
}
