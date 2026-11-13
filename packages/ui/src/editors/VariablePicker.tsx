import { ChevronDown, Plus } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * VariablePicker (design system §4 Editors): chooses the variable a card stores into. A button that
 * reads like a select and opens a searchable list grouped by scope; typing a name that does not
 * exist offers to create it. Data comes in through props (packages/ui has no data fetching).
 */

export interface PickerVariable {
  id: string;
  /** As written in templates: `workflow.email`. */
  path: string;
  type: string;
  /** Group heading: "Workflow", "Conversation", "User". */
  group: string;
}

export interface VariablePickerProps {
  id?: string;
  value: string | undefined;
  options: readonly PickerVariable[];
  onChange: (variableId: string) => void;
  /** Offered when the search is a valid name no option has. Creates the variable and picks it. */
  onCreate?: (name: string) => void;
  /** What the create row says it will make: "workflow variable". */
  createNoun?: string;
  placeholder?: string;
  invalid?: boolean;
  "aria-describedby"?: string;
}

type Row = { kind: "option"; option: PickerVariable } | { kind: "create"; name: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

/** Options matching `query` (anywhere in the path, case-insensitive), then a create row when it applies. */
export function pickerRows(options: readonly PickerVariable[], query: string, canCreate: boolean): Row[] {
  const q = query.trim().toLowerCase();
  const rows: Row[] = options
    .filter((o) => q === "" || o.path.toLowerCase().includes(q))
    .map((option) => ({ kind: "option", option }));
  const name = query.trim().replace(/^[a-z]+\./, "");
  if (canCreate && NAME.test(name) && !options.some((o) => o.path.split(".").at(-1) === name)) {
    rows.push({ kind: "create", name });
  }
  return rows;
}

export function VariablePicker({
  id,
  value,
  options,
  onChange,
  onCreate,
  createNoun = "variable",
  placeholder = "Choose a variable",
  invalid = false,
  ...aria
}: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const listId = useId();
  const searchId = useId();
  const rows = useMemo(() => pickerRows(options, query, onCreate !== undefined), [options, query, onCreate]);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const show = () => {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.id === value),
      ),
    );
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => button.current?.focus());
  };
  const pick = (row: Row) => {
    if (row.kind === "create") onCreate?.(row.name);
    else onChange(row.option.id);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length > 0) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  // Each group's heading goes above its first row.
  const headings = rows.map((row, i) => {
    if (row.kind !== "option") return undefined;
    const prev = rows[i - 1];
    return prev?.kind === "option" && prev.option.group === row.option.group ? undefined : row.option.group;
  });
  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        {...aria}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            show();
          }
        }}
        className="flex h-control w-full items-center gap-4 rounded-sm border border-hairline bg-surface px-5 text-start text-body transition-colors hover:border-strong focus-visible:border-accent aria-invalid:border-error"
      >
        {current ? (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-code-small text-primary" dir="ltr">
              {current.path}
            </span>
            <span className="text-small text-tertiary">{current.type}</span>
          </>
        ) : (
          <span className={`min-w-0 flex-1 truncate ${value ? "text-error" : "text-tertiary"}`}>
            {value ? "Missing variable" : placeholder}
          </span>
        )}
        <ChevronDown className="size-icon shrink-0 text-tertiary" strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 flex flex-col rounded-md border border-hairline bg-surface shadow-pop">
          <label htmlFor={searchId} className="sr-only">
            Search variables
          </label>
          <input
            id={searchId}
            // biome-ignore lint/a11y/noAutofocus: the list opened from its button; typing searches it.
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            value={query}
            placeholder="Search or type a new name"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            dir="ltr"
            className="h-control rounded-t-md border-b border-hairline bg-transparent px-5 font-mono text-code-small text-primary placeholder:font-sans placeholder:text-small placeholder:text-tertiary"
          />
          <div
            id={listId}
            role="listbox"
            aria-label="Variables"
            className="flex max-h-picker-height flex-col overflow-auto p-2"
          >
            {rows.length === 0 ? (
              <p className="px-4 py-3 text-small text-secondary">
                {options.length === 0 ? "No variables yet. Type a name to create one." : "No variable matches."}
              </p>
            ) : null}
            {rows.map((row, i) => {
              const heading = headings[i];
              return (
                <div key={row.kind === "option" ? row.option.id : "create"} className="flex flex-col">
                  {heading ? (
                    <span aria-hidden="true" className="px-4 pb-1 pt-3 text-small font-medium text-tertiary">
                      {heading}
                    </span>
                  ) : null}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(row);
                    }}
                    className={[
                      "flex h-row cursor-pointer items-center justify-between gap-4 rounded-sm px-4",
                      i === active ? "bg-accent-subtle" : "",
                    ].join(" ")}
                  >
                    {row.kind === "option" ? (
                      <>
                        <span className="truncate font-mono text-code-small text-primary" dir="ltr">
                          {row.option.path}
                        </span>
                        <span className="text-small text-tertiary">{row.option.type}</span>
                      </>
                    ) : (
                      <span className="flex min-w-0 items-center gap-3 text-body text-accent">
                        <Plus className="size-icon-sm shrink-0" strokeWidth={1.75} aria-hidden="true" />
                        <span className="truncate">
                          Create {createNoun} <span className="font-mono text-code-small">{row.name}</span>
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
