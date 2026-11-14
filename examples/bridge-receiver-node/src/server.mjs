/**
 * A reference webhook receiver for the Bridge API (task 5.6). No dependencies: copy it, set
 * WAKEEL_SIGNING_SECRETS and point your connection's webhook URL at it.
 *
 * What a receiver must do (architecture §9.2, ADR-005):
 * - verify X-Wakeel-Signature on the raw body before trusting anything (verify.mjs);
 * - treat an event id it has already processed as done, and still answer 2xx;
 * - answer 2xx within 10 seconds, and do slow work after answering.
 */
import { createServer } from "node:http";
import { verifyWakeel } from "./verify.mjs";

/** Webhook bodies are small JSON events; refuse anything bigger than this. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @param {object} options
 * @param {string[]} options.secrets Active signing secrets, newest first (two during a rotation).
 * @param {(event: object) => void | Promise<void>} [options.onEvent] Called once per new event.
 * @param {{ has(id: string): boolean; add(id: string): unknown }} [options.seen] Processed event ids.
 *   Use durable storage in production; this default forgets them on restart.
 */
export function createReceiver({ secrets, onEvent = logEvent, seen = new Set() }) {
  return createServer(async (req, res) => {
    if (req.method !== "POST") return end(res, 405);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return end(res, 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const header = req.headers["x-wakeel-signature"];
    if (!secrets.some((secret) => verifyWakeel(header, raw, secret))) return end(res, 401);

    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return end(res, 400);
    }
    // Deliveries are at least once: a repeat is acknowledged and not processed again.
    if (seen.has(event.id)) return end(res, 200);
    seen.add(event.id);
    try {
      await onEvent(event);
    } catch {
      // Not acknowledged: the platform retries it on its schedule.
      return end(res, 500);
    }
    return end(res, 204);
  });
}

function end(res, status) {
  res.writeHead(status);
  res.end();
}

function logEvent(event) {
  const text = event.type === "message.created" ? ` ${JSON.stringify(event.data?.message?.payload?.text ?? "")}` : "";
  console.log(`${event.conversation?.externalId ?? "-"} #${event.seq ?? "-"} ${event.type}${text}`);
}

// `node src/server.mjs`: WAKEEL_SIGNING_SECRETS=whsec_new,whsec_old PORT=8787
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const secrets = (process.env.WAKEEL_SIGNING_SECRETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) {
    console.error("Set WAKEEL_SIGNING_SECRETS to your connection's signing secret.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  createReceiver({ secrets }).listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
