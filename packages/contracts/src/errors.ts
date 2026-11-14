import { z } from "zod";

/**
 * Every error the platform can show. `title` says what happened; `fix` says what to do.
 * Both are user-facing sentences in sentence case, shown as written in the Studio and the API.
 * `{placeholders}` are filled by the caller.
 */
export const ERRORS = {
  // Request and auth
  validation_failed: {
    status: 400,
    title: "Some fields are not valid",
    fix: "Correct the highlighted fields and try again.",
  },
  unauthenticated: { status: 401, title: "You are not signed in", fix: "Sign in, or send a valid API key." },
  invalid_credentials: {
    status: 401,
    title: "The email or password is not correct",
    fix: "Check both and try again.",
  },
  email_taken: {
    status: 409,
    title: "An account with this email already exists",
    fix: "Sign in instead, or use a different email.",
  },
  last_owner: {
    status: 409,
    title: "A workspace needs at least one owner",
    fix: "Make another member an owner first.",
  },
  csrf_failed: {
    status: 403,
    title: "This request did not come from the Studio",
    fix: "Reload the page and try again.",
  },
  forbidden: { status: 403, title: "Your role does not allow this", fix: "Ask a workspace admin for access." },
  not_found: { status: 404, title: "We could not find that", fix: "Check the id, or it may have been deleted." },
  revision_conflict: {
    status: 409,
    title: "This was changed elsewhere",
    fix: "Reload to get the latest copy, then reapply your change.",
  },
  idempotency_mismatch: {
    status: 409,
    title: "This idempotency key was used with different content",
    fix: "Use a new key for a new request.",
  },
  rate_limited: { status: 429, title: "Too many requests", fix: "Wait {retryAfter} seconds and try again." },
  quota_exceeded: {
    status: 429,
    title: "The workspace reached its {quota} limit",
    fix: "Raise the cap in usage settings or wait for the next period.",
  },
  payload_too_large: { status: 413, title: "That is larger than {limit}", fix: "Send less data in one request." },

  // Publish and definition
  definition_invalid: {
    status: 422,
    title: "The bot has {count} problems that block publishing",
    fix: "Open the issues panel and resolve each one.",
  },
  resource_in_use: {
    status: 409,
    title: "The published bot still uses this",
    fix: "Remove it from {usages}, publish, then delete it.",
  },

  // Turn engine
  step_limit_exceeded: {
    status: 500,
    title: "The bot ran {limit} steps without finishing",
    fix: "Look for a loop between nodes; add a condition that ends it or a step that waits for the user.",
  },
  node_loop_detected: {
    status: 500,
    title: '"{node}" ran {limit} times in one turn',
    fix: "Add a condition that leaves the loop, or wait for user input inside it.",
  },
  stack_overflow: {
    status: 500,
    title: "Workflows are nested more than {limit} deep",
    fix: "Check for a workflow that calls itself.",
  },
  turn_timeout: {
    status: 504,
    title: "The bot took longer than {limit} seconds",
    fix: "Find the slow step in the trace; shorten it or move it to a suspended tool.",
  },
  state_too_large: {
    status: 500,
    title: "Conversation data grew past {limit}",
    fix: "Store ids instead of whole records. Largest variables: {largest}.",
  },
  variable_type_mismatch: {
    status: 500,
    title: '"{variable}" expects {expected} but received {received}',
    fix: "Convert the value, or change the variable type.",
  },
  variable_not_found: {
    status: 500,
    title: '"{name}" is not a variable in this scope',
    fix: "Create the variable or correct the name.",
  },
  expression_error: {
    status: 500,
    title: "An expression failed: {message}",
    fix: "Fix the expression `{expression}`.",
  },
  template_error: {
    status: 500,
    title: "A message template could not be filled in",
    fix: "Check `{expression}` in the highlighted field.",
  },
  message_invalid: {
    status: 500,
    title: "The message could not be sent because {reason}",
    fix: "Fix the highlighted field on the card.",
  },
  no_route: { status: 500, title: '"{node}" has nowhere to go next', fix: "Connect its output to another node." },
  workflow_input_missing: {
    status: 500,
    title: '"{workflow}" needs a value for "{input}"',
    fix: "Set it on the card that calls the workflow.",
  },

  // Code
  code_error: {
    status: 500,
    title: "Your code threw: {message}",
    fix: "See line {line}. The trace shows the variables at that point.",
  },
  code_timeout: {
    status: 504,
    title: "Your code ran longer than {limit} ms",
    fix: "Remove long loops, or raise the card's time limit (maximum 60 s).",
  },
  code_memory_exceeded: {
    status: 500,
    title: "Your code used more than {limit} MB",
    fix: "Process less data at once.",
  },
  code_syntax_error: { status: 422, title: "Your code has a syntax error: {message}", fix: "See line {line}." },
  fetch_blocked: {
    status: 403,
    title: "Requests to {host} are not allowed",
    fix: "Private and internal addresses cannot be called from bot code.",
  },
  fetch_failed: {
    status: 502,
    title: "The request to {host} failed: {message}",
    fix: "Check the address and that the service is reachable.",
  },

  // Autonomous node
  autonomy_loop_exceeded: {
    status: 500,
    title: '"{node}" did not finish within {limit} attempts',
    fix: "Simplify the instructions, or raise the limit. The trace shows what it tried each time.",
  },
  autonomy_protocol_error: {
    status: 502,
    title: "The model's reply was not in the expected format",
    fix: "Use a model marked as supported for autonomous nodes.",
  },
  autonomy_exit_invalid: {
    status: 500,
    title: 'The model chose "{exit}" with data that does not match its schema',
    fix: "Loosen the exit's schema or describe the fields more clearly.",
  },
  tool_input_invalid: {
    status: 500,
    title: '"{tool}" was called with invalid input: {message}',
    fix: "Describe the tool's inputs more precisely.",
  },
  tool_failed: {
    status: 500,
    title: '"{tool}" failed: {message}',
    fix: "Open the tool call in the trace to see its input.",
  },
  write_not_allowed: {
    status: 500,
    title: 'The node tried to change "{variable}" without write access',
    fix: "Grant write access on the node, or remove the instruction that sets it.",
  },

  // Models
  model_unavailable: {
    status: 503,
    title: "{model} did not respond",
    fix: "Try again; if it continues, switch models or check the provider status.",
  },
  model_auth_failed: {
    status: 502,
    title: "The key for {provider} was rejected",
    fix: "Update the key in workspace settings.",
  },
  model_context_exceeded: {
    status: 500,
    title: "The conversation no longer fits in {model}'s context",
    fix: "Lower the transcript budget or shorten the instructions.",
  },
  model_not_configured: {
    status: 422,
    title: "No model is set for this step",
    fix: "Choose a default model in bot settings.",
  },

  // Knowledge and tables
  kb_not_ready: { status: 409, title: '"{kb}" is still being indexed', fix: "Wait for indexing to finish." },
  document_parse_failed: {
    status: 422,
    title: 'We could not read "{document}"',
    fix: "If it is a scan, upload a clearer copy; otherwise try exporting it again as PDF.",
  },
  source_fetch_failed: {
    status: 502,
    title: "We could not fetch {url}: {message}",
    fix: "Check that the page is public.",
  },
  table_row_invalid: {
    status: 422,
    title: "Row does not match the table: {message}",
    fix: "Fix the highlighted column.",
  },
  table_limit_reached: {
    status: 409,
    title: '"{table}" reached {limit} rows',
    fix: "Delete rows you no longer need, or raise the limit.",
  },
  unique_violation: {
    status: 409,
    title: "A row with this {column} already exists",
    fix: "Use a different value, or update the existing row.",
  },

  // Bridge
  conversation_ended: { status: 409, title: "This conversation has ended", fix: "Send a new message to start again." },
  not_handed_off: { status: 409, title: "This conversation is not handed off", fix: "Nothing to release." },
  webhook_url_blocked: {
    status: 422,
    title: "That webhook address cannot be used",
    fix: "Use a public https address.",
  },
  connection_disabled: {
    status: 409,
    title: "This connection is turned off after repeated delivery failures",
    fix: "Fix the receiving endpoint, then turn the connection back on.",
  },
  // Webhook delivery attempts (ADR-028). Stored on the attempt and shown in the Deliveries tab.
  webhook_rejected: {
    status: 502,
    title: "The webhook endpoint did not accept the event",
    fix: "Make the endpoint answer with a 2xx status within 10 seconds. The response status is shown with the attempt.",
  },
  webhook_redirected: {
    status: 502,
    title: "The webhook endpoint answered with a redirect",
    fix: "Webhooks do not follow redirects. Set the connection's webhook URL to the final address.",
  },
  webhook_secret_missing: {
    status: 409,
    title: "This connection has no signing secret",
    fix: "Generate a signing secret for the connection, then replay the event.",
  },
  webhook_stale: {
    status: 410,
    title: "A typing event was dropped because it was too old to send",
    fix: "Nothing to do. Typing events are best-effort.",
  },

  internal_error: {
    status: 500,
    title: "Something went wrong on our side",
    fix: "Try again. If it continues, contact support with request id {requestId}.",
  },
} as const satisfies Record<string, { status: number; title: string; fix: string }>;

export type ErrorCode = keyof typeof ERRORS;
export const ErrorCode = z.enum(Object.keys(ERRORS) as [ErrorCode, ...ErrorCode[]]);

/** RFC 9457 problem document returned by every API on failure. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  fix: z.string(),
  requestId: z.string(),
  errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
  /** `revision_conflict` only: the server's copy, so the client can merge or reload (architecture §3). */
  current: z.object({ rev: z.number().int(), doc: z.unknown() }).optional(),
});
export type Problem = z.infer<typeof Problem>;

/** Fill `{placeholders}` in a title or fix sentence. Unknown placeholders are left as-is. */
export const fill = (text: string, params: Record<string, string | number> = {}) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
