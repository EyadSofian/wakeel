import type { ModelSummary } from "@wakeel/contracts";
import { Select } from "@wakeel/ui";
import type { SelectHTMLAttributes } from "react";

export const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "openai-compatible": "OpenAI-compatible server",
} as const;

/**
 * Picks a chat model from the registry (task 6.2), grouped by provider. A model whose provider has
 * no key in this workspace is listed but cannot be chosen, and says why.
 */
export function ModelPicker({
  models,
  value,
  onValueChange,
  allowNone,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  models: readonly ModelSummary[];
  value: string | null;
  onValueChange: (id: string | null) => void;
  /** Label of the "none" choice, when one is allowed. */
  allowNone?: string;
}) {
  const chat = models.filter((m) => m.kind === "chat");
  const providers = [...new Set(chat.map((m) => m.provider))];
  return (
    <Select
      {...rest}
      value={value ?? ""}
      onChange={(e) => onValueChange(e.target.value === "" ? null : e.target.value)}
    >
      {allowNone !== undefined || value === null ? <option value="">{allowNone ?? "Choose a model"}</option> : null}
      {providers.map((p) => (
        <optgroup key={p} label={PROVIDER_LABELS[p]}>
          {chat
            .filter((m) => m.provider === p)
            .map((m) => (
              <option key={m.id} value={m.id} disabled={!m.keySet && m.id !== value}>
                {m.id}
                {m.keySet ? "" : " (add a key first)"}
              </option>
            ))}
        </optgroup>
      ))}
    </Select>
  );
}
