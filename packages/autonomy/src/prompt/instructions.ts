import type { Json } from "@wakeel/contracts";

/**
 * Renders a node's instructions for the system prompt (ADR-031 §1): `{{ path }}` placeholders whose
 * root is `bot` or `env` are filled in; anything else (user, conversation, workflow, event, turn
 * values, or a non-path expression) becomes `‹expression›`, and its value is shown to the model in
 * the variables block instead. End-user text therefore never reaches the system prompt.
 */
const PLACEHOLDER = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export function renderInstructions(
  template: string,
  trusted: { bot: Record<string, Json>; env: Record<string, Json> },
): string {
  return template.replace(PLACEHOLDER, (_whole, expression: string) => {
    const expr = expression.trim();
    if (!PATH.test(expr)) return `‹${expr}›`;
    const [root, ...rest] = expr.split(".");
    if (root !== "bot" && root !== "env") return `‹${expr}›`;
    let value: Json | undefined = trusted[root];
    for (const key of rest) {
      value =
        value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>)[key] : undefined;
    }
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
