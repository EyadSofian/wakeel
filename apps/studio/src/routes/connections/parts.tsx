import { Button, Dialog, Field, Input } from "@wakeel/ui";
import { useState } from "react";
import { EVENT_LABELS, EVENT_TYPES } from "./model";

/**
 * Pieces shared by the Connections screens (task 5.5): the dialog that shows a secret once, a code
 * block with a copy button, and the event checklist.
 */

/** Shows a signing secret or a bridge key once (ADR-030 §2), like a new API key. */
export function ShownOnceDialog({
  open,
  title,
  label,
  value,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  value: string | undefined;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCopied(false);
          onClose();
        }
      }}
      title={title}
      description="This is the only time it is shown. Store it somewhere safe; if it is lost, make a new one."
      footer={
        <>
          <Button
            size="large"
            onClick={() => {
              if (value) void navigator.clipboard?.writeText(value).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Done
          </Button>
        </>
      }
    >
      <Field label={label}>
        {(p) => (
          <Input
            {...p}
            readOnly
            dir="ltr"
            className="font-mono"
            data-testid="shown-once"
            value={value ?? ""}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </Field>
    </Dialog>
  );
}

/** Code to copy. Always left to right: code reads the same in an Arabic interface. */
export function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="flex flex-col overflow-hidden rounded-md border border-hairline">
      <figcaption className="flex items-center justify-between gap-4 border-b border-hairline bg-subtle px-5 py-2">
        <span className="text-small text-secondary">{label}</span>
        <Button
          variant="ghost"
          size="compact"
          aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </figcaption>
      <pre dir="ltr" className="overflow-x-auto px-5 py-4 font-mono text-code-small text-primary">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** Which events the connection's webhook receives. */
export function EventChecklist({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-3 text-body font-medium text-primary">Events</legend>
      {EVENT_TYPES.map((type) => (
        <label key={type} className="flex items-start gap-4">
          <input
            type="checkbox"
            className="mt-1 size-icon accent-accent"
            checked={value.includes(type)}
            onChange={(e) => onChange(e.target.checked ? [...value, type] : value.filter((t) => t !== type))}
          />
          <span className="flex flex-col">
            <span className="text-body text-primary">{EVENT_LABELS[type].label}</span>
            <span className="text-small text-secondary">{EVENT_LABELS[type].help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
