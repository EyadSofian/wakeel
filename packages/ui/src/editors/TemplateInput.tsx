import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";

/**
 * TemplateInput (design system §4 Editors): multi-line text for bot messages, `dir="auto"`, with
 * `{{ … }}` placeholders drawn as chips and `{{` opening variable autocomplete.
 *
 * The chips are a mirrored layer behind a transparent-background textarea: the layer has the same
 * font, padding and wrapping and draws only the chip backgrounds, so the text the builder edits is
 * the real textarea (selection, IME, spell check and undo all native). The layer also sizes the
 * field, so it grows with its content.
 */
export interface VariableOption {
  /** As written in a template or expression: `workflow.email`. */
  path: string;
  /** Shown next to it: `string`, `number`, … */
  type: string;
}

export interface TemplateInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Called when the field loses focus: the moment the canvas commits one undo step. */
  onCommit?: () => void;
  variables: readonly VariableOption[];
  placeholder?: string;
  /** Minimum height in rows. */
  rows?: number;
  invalid?: boolean;
  "aria-describedby"?: string;
  "aria-label"?: string;
}

/** `{{ … }}` spans of `text`, with the plain text around them. */
export function splitTemplate(text: string): { text: string; placeholder: boolean }[] {
  const out: { text: string; placeholder: boolean }[] = [];
  const re = /\{\{[^{}]*\}\}/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), placeholder: false });
    out.push({ text: m[0], placeholder: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), placeholder: false });
  return out;
}

/** The text being completed: what follows an open `{{` before the caret, or undefined. */
export function completionQuery(text: string, caret: number): string | undefined {
  const m = /\{\{\s*([\w.]*)$/.exec(text.slice(0, caret));
  return m ? (m[1] ?? "") : undefined;
}

const field = "col-start-1 row-start-1 w-full whitespace-pre-wrap break-words px-5 py-3 text-body";

export function TemplateInput({
  id,
  value,
  onChange,
  onCommit,
  variables,
  placeholder,
  rows = 2,
  invalid = false,
  ...aria
}: TemplateInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string>();
  const [active, setActive] = useState(0);
  const listId = useId();

  const matches = useMemo(
    () =>
      query === undefined
        ? []
        : variables.filter((v) => v.path.toLowerCase().includes(query.toLowerCase())).slice(0, 8),
    [query, variables],
  );

  const refresh = (text: string, caret: number) => {
    const q = completionQuery(text, caret);
    setQuery(q);
    setActive(0);
  };

  const insert = (path: string) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/\{\{\s*[\w.]*$/, "");
    const after = value.slice(caret).replace(/^[\w.]*\s*\}\}/, "");
    const chip = `{{${path}}}`;
    onChange(before + chip + after);
    setQuery(undefined);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length + chip.length, before.length + chip.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query === undefined || matches.length === 0) return;
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

  const open = query !== undefined && matches.length > 0;

  return (
    <div className="relative">
      <div
        className={[
          "grid rounded-sm border bg-surface transition-colors",
          // An invalid field stays red while focused, so the problem is never hidden by the focus colour.
          invalid ? "border-error" : "border-hairline hover:border-strong focus-within:border-accent",
        ].join(" ")}
      >
        {/* The mirror: same box as the textarea, transparent text, chip backgrounds. One trailing
            space keeps a final empty line from collapsing. */}
        <div aria-hidden="true" dir="auto" className={`${field} text-transparent`}>
          {splitTemplate(value).map((s, i) =>
            s.placeholder ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity besides order.
              <mark key={i} className="rounded-xs bg-accent-subtle text-transparent">
                {s.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity besides order.
              <span key={i}>{s.text}</span>
            ),
          )}{" "}
        </div>
        <textarea
          ref={ref}
          id={id}
          dir="auto"
          // The minimum height; the mirror grows the field past it as the text wraps.
          rows={rows}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          {...aria}
          onChange={(e) => {
            onChange(e.target.value);
            refresh(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key))
              refresh(e.currentTarget.value, e.currentTarget.selectionStart);
          }}
          onBlur={() => {
            setQuery(undefined);
            onCommit?.();
          }}
          className={`${field} resize-none overflow-hidden bg-transparent text-primary outline-hidden placeholder:text-tertiary`}
        />
      </div>
      {open ? <Suggestions id={listId} items={matches} active={active} onPick={insert} /> : null}
    </div>
  );
}

/** The autocomplete list below a field. Mouse down picks without blurring the field first. */
export function Suggestions({
  id,
  items,
  active,
  onPick,
}: {
  id: string;
  items: readonly VariableOption[];
  active: number;
  onPick: (path: string) => void;
}): ReactNode {
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Variables"
      className="absolute inset-x-0 top-full z-20 mt-1 flex max-h-picker-height flex-col overflow-auto rounded-md border border-hairline bg-surface p-2 shadow-pop"
    >
      {items.map((v, i) => (
        <div
          key={v.path}
          role="option"
          tabIndex={-1}
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(v.path);
          }}
          className={[
            "flex h-row cursor-pointer items-center justify-between gap-4 rounded-sm px-4",
            i === active ? "bg-accent-subtle" : "",
          ].join(" ")}
        >
          <span className="truncate font-mono text-code-small text-primary">{v.path}</span>
          <span className="text-small text-tertiary">{v.type}</span>
        </div>
      ))}
    </div>
  );
}
