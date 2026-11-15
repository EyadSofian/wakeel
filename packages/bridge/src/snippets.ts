/**
 * Copy-ready examples for the Connections screen's Setup tab (design system §5.11, task 5.5): a cURL
 * call to the Bridge API, and the webhook signature check (architecture §9.2) in Node, Python and
 * PHP. Plain strings, safe to import in the browser. Each check is run against real signatures in
 * test/snippets.test.ts, so the copied code is known to work.
 *
 * Every check: reads `t` and every `v1` from `X-Wakeel-Signature`, refuses a timestamp more than
 * 300 s away, computes HMAC-SHA256(secret, `${t}.${rawBody}`) and compares it in constant time with
 * each `v1` (two during a rotation). It must run on the raw body, before any JSON parsing.
 */

export interface CurlExampleInput {
  /** The public base URL of the API, for example https://api.example.com. */
  apiBaseUrl: string;
}

/** `sendMessage` with `wait`, which answers with the bot's reply in the same call. */
export function curlExample({ apiBaseUrl }: CurlExampleInput): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return [
    `curl -X POST "${base}/v1/bridge/conversations/chat-1/messages?wait=20" \\`,
    `  -H "Authorization: Bearer $WAKEEL_BRIDGE_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"userId": "user-1", "message": {"type": "text", "text": "Hello"}}'`,
  ].join("\n");
}

export const SIGNATURE_CHECK_NODE = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (a string or Buffer), before JSON.parse.
export function verifyWakeel(header, rawBody, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(header ?? "").split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\`).update(rawBody).digest();
  return signatures.some((s) => {
    const given = Buffer.from(s ?? "", "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
`;

export const SIGNATURE_CHECK_PYTHON = `import hashlib
import hmac
import time


def verify_wakeel(header, raw_body, secret, now_seconds=None):
    """raw_body: the request body as bytes, exactly as received, before json.loads."""
    now_seconds = int(time.time()) if now_seconds is None else now_seconds
    parts = [p.strip().split("=", 1) for p in (header or "").split(",")]
    timestamps = [v for k, *v in parts if k == "t" and v]
    signatures = [v[0] for k, *v in parts if k == "v1" and v]
    try:
        t = int(timestamps[0][0])
    except (IndexError, ValueError):
        return False
    if abs(now_seconds - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in signatures)
`;

export const SIGNATURE_CHECK_PHP = `<?php
// $rawBody: file_get_contents('php://input'), before json_decode.
function verify_wakeel(string $header, string $rawBody, string $secret, ?int $now = null): bool {
    $now = $now ?? time();
    $t = null;
    $signatures = [];
    foreach (explode(',', $header) as $part) {
        $pair = explode('=', trim($part), 2);
        if (count($pair) !== 2) continue;
        if ($pair[0] === 't' && ctype_digit($pair[1])) $t = (int) $pair[1];
        if ($pair[0] === 'v1') $signatures[] = $pair[1];
    }
    if ($t === null || abs($now - $t) > 300) return false;
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    foreach ($signatures as $signature) {
        if (hash_equals($expected, $signature)) return true;
    }
    return false;
}
`;

export const SIGNATURE_CHECKS = [
  { id: "node", label: "Node", code: SIGNATURE_CHECK_NODE },
  { id: "python", label: "Python", code: SIGNATURE_CHECK_PYTHON },
  { id: "php", label: "PHP", code: SIGNATURE_CHECK_PHP },
] as const;
