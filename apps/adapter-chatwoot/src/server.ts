import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BridgeEvent } from "@wakeel/contracts";
import { bridgeClient } from "./bridge";
import { chatwootClient } from "./chatwoot";
import type { AdapterConfig, Pair } from "./config";
import type { HttpCall } from "./http";
import { channelKey, handleChatwootWebhook, type InboundDeps } from "./inbound";
import { chatwootConversationId, handleBridgeEvent } from "./outbound";
import { DAY_SECONDS, type Store } from "./store";
import { verifySignature } from "./verify";

/** Webhook bodies are small JSON documents; anything bigger is refused before parsing. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
  config: AdapterConfig;
  store: Store;
  http: HttpCall;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: InboundDeps["log"];
  /** Runs work after the response; tests await it, production lets it run. */
  defer?: (work: Promise<void>) => void;
}

/**
 * Two webhook endpoints per pair (spec §3 and §4) plus `/healthz`. Chatwoot is answered at once and
 * served afterwards; the platform is answered only after Chatwoot accepted the result.
 */
export function createAdapterServer(deps: ServerDeps): Server {
  const pairs = new Map(deps.config.pairs.map((p) => [p.id, p]));
  const defer = deps.defer ?? ((work) => void work);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://adapter");
      if (req.method === "GET" && url.pathname === "/healthz") return end(res, 200, { status: "ok" });
      const match = /^\/(chatwoot|bridge)\/([A-Za-z0-9_-]+)\/webhook$/.exec(url.pathname);
      const pair = match ? pairs.get(match[2] ?? "") : undefined;
      if (!match || !pair) return end(res, 404);
      if (req.method !== "POST") return end(res, 405);
      const raw = await readBody(req);
      if (raw === undefined) return end(res, 413);
      if (match[1] === "chatwoot") return onChatwoot(deps, pair, raw, res, defer);
      return await onBridge(deps, pair, req, raw, res);
    } catch (error) {
      deps.log("error", "Adapter request failed", { error: describe(error) });
      if (!res.headersSent) end(res, 500);
    }
  });
}

function onChatwoot(
  deps: ServerDeps,
  pair: Pair,
  raw: Buffer,
  res: ServerResponse,
  defer: (work: Promise<void>) => void,
): void {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    end(res, 400);
    return;
  }
  // Always 200 quickly (spec §3); the Bridge calls happen after the answer.
  end(res, 200);
  const inbound: InboundDeps = {
    pair,
    bridge: bridgeClient(pair, deps.http, deps.sleep),
    chatwoot: chatwootClient(pair, deps.http),
    store: deps.store,
    log: deps.log,
  };
  defer(
    handleChatwootWebhook(inbound, body)
      .catch(async (error) => {
        deps.log("error", "Could not pass a Chatwoot message to the platform", {
          pair: pair.id,
          error: describe(error),
        });
        // After the retries: tell a human in Chatwoot and hand the conversation over (spec §6).
        const id = (body as { conversation?: { id?: unknown } })?.conversation?.id;
        if (typeof id === "number") {
          await inbound.chatwoot.privateNote(id, "The assistant is unavailable. Please take over this conversation.");
          await inbound.chatwoot.setStatus(id, "open");
        }
      })
      .catch(() => undefined),
  );
}

async function onBridge(deps: ServerDeps, pair: Pair, req: IncomingMessage, raw: Buffer, res: ServerResponse) {
  const header = req.headers["x-wakeel-signature"];
  if (!verifySignature(Array.isArray(header) ? header[0] : header, raw, pair.bridgeSigningSecrets, nowSeconds(deps)))
    return end(res, 401);
  let event: BridgeEvent;
  try {
    event = BridgeEvent.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    // Signed but not an event this version understands: acknowledge so it is not retried forever.
    deps.log("warn", "Ignored a signed webhook that is not a known Bridge event", { pair: pair.id });
    return end(res, 204);
  }
  // Deliveries are at least once; a repeat is acknowledged and not sent to Chatwoot again.
  const seen = `event:${pair.id}:${event.id}`;
  if (!(await deps.store.claim(seen, DAY_SECONDS))) return end(res, 200);
  const cwId = chatwootConversationId(pair, event.conversation.externalId);
  const channel = cwId === undefined ? undefined : await deps.store.getJson<string>(channelKey(pair, cwId));
  try {
    await handleBridgeEvent({ pair, chatwoot: chatwootClient(pair, deps.http), store: deps.store }, event, channel);
  } catch (error) {
    await deps.store.release(seen);
    deps.log("warn", "Chatwoot refused a bot event; the platform will retry it", {
      pair: pair.id,
      type: event.type,
      error: describe(error),
    });
    return end(res, 502);
  }
  return end(res, 204);
}

const nowSeconds = (deps: ServerDeps) => Math.floor(deps.now() / 1000);

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function end(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Error text without request bodies or headers, so tokens never reach the log. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
