import { CornerDownLeft } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

/**
 * The message box (§5.3). `Enter` sends and `Shift+Enter` adds a line; the box clears at once on
 * send. Text direction follows what is typed (`dir="auto"`), so Arabic starts on the right.
 */
export function Composer({
  onSend,
  disabled = false,
  placeholder = "Message…",
  label = "Message",
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
    ref.current?.focus();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <form onSubmit={onSubmit} className="flex items-end gap-3 border-t border-hairline bg-surface px-5 py-4">
      <textarea
        ref={ref}
        aria-label={label}
        dir="auto"
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-tile-lg min-h-control flex-1 resize-none rounded-md border border-hairline bg-surface px-4 py-3 text-content text-primary placeholder:text-tertiary focus-visible:border-accent-border focus-visible:outline-none field-sizing-content"
      />
      <button
        type="submit"
        aria-label="Send"
        title="Send (Enter)"
        disabled={disabled || text.trim() === ""}
        className="flex size-control shrink-0 items-center justify-center rounded-md bg-accent text-on-accent hover:bg-accent-hover disabled:bg-muted disabled:text-tertiary"
      >
        <CornerDownLeft className="size-icon" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </form>
  );
}
