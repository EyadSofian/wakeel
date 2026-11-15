import type { Json } from "@wakeel/contracts";
import { Button, Field, Input, Textarea } from "@wakeel/ui";
import { type FormEvent, useState } from "react";
import { useEmulator } from "./controller";

/**
 * "as Test user" (§5.3): the data a bridge would push about the end user. The bot reads it as
 * `user.attributes` (name, email, phone and locale included, ADR-024). Saving applies it to the
 * current conversation; it is also sent with the first message after a reset.
 */
export function TestUserForm({ onDone }: { onDone: () => void }) {
  const user = useEmulator((s) => s.user);
  const saveUser = useEmulator((s) => s.saveUser);
  const [name, setName] = useState(user.name ?? "");
  const [locale, setLocale] = useState(user.locale ?? "");
  const [attributes, setAttributes] = useState(
    Object.keys(user.attributes).length > 0 ? JSON.stringify(user.attributes, null, 2) : "",
  );
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let parsed: Record<string, Json> = {};
    if (attributes.trim() !== "") {
      try {
        const value: unknown = JSON.parse(attributes);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        parsed = value as Record<string, Json>;
      } catch {
        setError('Attributes must be a JSON object, like {"plan": "pro"}.');
        return;
      }
    }
    setError(undefined);
    setSaving(true);
    try {
      await saveUser({ name: name.trim() || undefined, locale: locale.trim() || undefined, attributes: parsed });
      onDone();
    } catch {
      setError("The test user could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label="Test user"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-5 border-b border-hairline bg-subtle px-6 py-5"
    >
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Test user"
          />
        )}
      </Field>
      <Field label="Locale" help="For example ar-EG or en">
        {(control) => (
          <Input
            {...control}
            dir="ltr"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            placeholder="ar-EG"
          />
        )}
      </Field>
      <Field label="Attributes" help="JSON the bot reads as user.attributes" {...(error ? { error } : {})}>
        {(control) => (
          <Textarea
            {...control}
            dir="ltr"
            rows={4}
            className="font-mono text-code-small"
            value={attributes}
            onChange={(e) => setAttributes(e.target.value)}
            placeholder={'{ "plan": "pro" }'}
          />
        )}
      </Field>
      <div className="flex justify-end gap-3">
        <Button type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}
