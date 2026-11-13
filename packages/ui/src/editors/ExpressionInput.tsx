import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { Suggestions, type VariableOption } from "./TemplateInput";

/**
 * ExpressionInput (design system §4 Editors): one line of JavaScript, monospace, always
 * left-to-right (§6: code is LTR), with variable autocomplete on the word before the caret and the
 * field's error drawn by its parent through `invalid`.
 */
export interface ExpressionInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onCommit?: () => void;
  variables: readonly VariableOption[];
  placeholder?: string;
  invalid?: boolean;
  "aria-describedby"?: string;
  "aria-label"?: string;
}

/** The identifier path ending at the caret, if it looks like the start of a variable. */
export function expressionQuery(text: string, caret: number): string | undefined {
  const m = /([A-Za-z_][\w.]*)$/.exec(text.slice(0, caret));
  return m?.[1];
}

export function ExpressionInput({
  id,
  value,
  onChange,
  onCommit,
  variables,
  placeholder,
  invalid = false,
  ...aria
}: ExpressionInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState<string>();
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = useMemo(
    () =>
      query === undefined ? [] : variables.filter((v) => v.path.startsWith(query) && v.path !== query).slice(0, 8),
    [query, variables],
  );
  const open = matches.length > 0;

  const insert = (path: string) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/[A-Za-z_][\w.]*$/, "");
    const next = before + path + value.slice(caret);
    onChange(next);
    setQuery(undefined);
    requestAnimationFrame(() => el.setSelectionRange(before.length + path.length, before.length + path.length));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === "Enter") e.currentTarget.blur();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const pick = matches[active];
      if (pick) insert(pick.path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setQuery(undefined);
    }
  };

  return (
    <div className="relative">
      <input
        ref={ref}
        id={id}
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        {...aria}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(expressionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setQuery(undefined);
          onCommit?.();
        }}
        className={[
          "h-control w-full rounded-sm border bg-surface px-5 font-mono text-code-small text-primary transition-colors placeholder:text-tertiary",
          invalid ? "border-error" : "border-hairline hover:border-strong focus-visible:border-accent",
        ].join(" ")}
      />
      {open ? <Suggestions id={listId} items={matches} active={active} onPick={insert} /> : null}
    </div>
  );
}
