import { Kbd, PaletteFrame } from "@wakeel/ui";
import { Search } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { useCanvas } from "../canvas/context";
import { fuzzyFilter } from "./fuzzy";
import { type GoToItem, goToItems } from "./palette-items";
import { type Action, allActions, useShell, useShellState } from "./shell-store";
import { useGoTo } from "./use-go-to";

/**
 * The command palette (design system §5.15, task 2.8): `⌘K` anywhere in a bot. Lists every
 * registered action with its shortcut, then everything the builder can go to. Fuzzy match; the
 * list follows each keystroke without animation; arrows move, `Enter` runs, `⌘Enter` on a node or
 * card opens it in the inspector and keeps the palette open.
 */

/** Go-to rows drawn at once; the rest are a keystroke away. */
const GO_TO_LIMIT = 200;

type Row = { kind: "action"; action: Action; unavailable: string | undefined } | { kind: "go"; item: GoToItem };

const rowId = (r: Row) => (r.kind === "action" ? `a:${r.action.id}` : `g:${r.item.id}`);

export function CommandPalette() {
  const { store } = useShell();
  const open = useShellState((s) => s.palette);
  const close = () => store.getState().set({ palette: false });
  // An action that moved focus (a menu, a rename field) keeps it; otherwise Radix restores it.
  const ran = useRef(false);
  return (
    <PaletteFrame
      open={open}
      onOpenChange={(next) => store.getState().set({ palette: next })}
      label="Command palette"
      onCloseAutoFocus={(e) => {
        if (ran.current) e.preventDefault();
        ran.current = false;
      }}
    >
      <PaletteBody
        onDone={() => {
          ran.current = true;
          close();
        }}
      />
    </PaletteFrame>
  );
}

function PaletteBody({ onDone }: { onDone: () => void }) {
  const sources = useShellState((s) => s.sources);
  const manifest = useCanvas((s) => s.manifest?.doc);
  const workflows = useCanvas((s) => s.workflows);
  const go = useGoTo();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);

  // Availability is read once per opening and per keystroke, not subscribed: the palette is modal.
  // What can run now comes first; what cannot stays listed, dimmed, with the reason (like the menus).
  const actions = useMemo(() => {
    const rows = allActions({ sources }).map((action) => ({ action, unavailable: action.unavailable?.() }));
    return [...rows.filter((r) => r.unavailable === undefined), ...rows.filter((r) => r.unavailable !== undefined)];
  }, [sources]);
  const places = useMemo(
    () =>
      manifest
        ? goToItems(
            manifest,
            Object.values(workflows).map((w) => w.doc),
          )
        : [],
    [manifest, workflows],
  );

  const actionRows = useMemo<Row[]>(
    () =>
      fuzzyFilter(actions, query, (a) => `${a.action.label} ${a.action.keywords ?? ""}`).map((a) => ({
        kind: "action",
        ...a,
      })),
    [actions, query],
  );
  const goRows = useMemo<Row[]>(
    () =>
      fuzzyFilter(places, query, (p) => p.search)
        .slice(0, GO_TO_LIMIT)
        .map((item) => ({ kind: "go", item })),
    [places, query],
  );
  const enabled = useMemo(
    () => [...actionRows, ...goRows].filter((r) => r.kind === "go" || r.unavailable === undefined),
    [actionRows, goRows],
  );
  const current = enabled[Math.min(active, enabled.length - 1)];

  const runRow = (row: Row, inspect: boolean) => {
    if (row.kind === "action") {
      if (row.unavailable !== undefined) return;
      onDone();
      row.action.run();
      return;
    }
    if (inspect && row.item.target.type === "node") {
      // Open it in the inspector behind the palette; the palette stays where it was.
      go.target(row.item.target);
      return;
    }
    onDone();
    go.target(row.item.target);
  };

  const move = (step: number) => {
    if (enabled.length === 0) return;
    const next = (Math.min(active, enabled.length - 1) + step + enabled.length) % enabled.length;
    setActive(next);
    const row = enabled[next];
    if (row)
      list.current?.querySelector(`[data-row="${CSS.escape(rowId(row))}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) runRow(current, e.metaKey || e.ctrlKey);
    }
  };

  const optionProps = (row: Row) => {
    const selectable = row.kind === "go" || row.unavailable === undefined;
    const selected = current !== undefined && rowId(current) === rowId(row);
    return {
      id: `${listId}-${rowId(row)}`,
      "data-row": rowId(row),
      role: "option" as const,
      "aria-selected": selected,
      ...(selectable ? {} : { "aria-disabled": true }),
      tabIndex: -1,
      onMouseMove: () => {
        if (selectable && !selected) setActive(enabled.indexOf(row));
      },
      onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
      onClick: (e: { metaKey: boolean; ctrlKey: boolean }) => runRow(row, e.metaKey || e.ctrlKey),
      onKeyDown: () => undefined,
      className: [
        "flex h-row items-center gap-4 rounded-sm px-4",
        selectable ? "cursor-pointer" : "cursor-not-allowed",
        selected ? "bg-accent-subtle" : "",
      ].join(" "),
    };
  };

  const nothing = actionRows.length === 0 && goRows.length === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keys typed in the search field move the list.
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <label className="relative block shrink-0 border-b border-hairline">
        <span className="sr-only">Search commands and places</span>
        <Search
          className="pointer-events-none absolute start-6 top-1/2 size-icon -translate-y-1/2 text-tertiary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette opens to be typed into; Esc closes it.
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${rowId(current)}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            list.current?.scrollTo({ top: 0 });
          }}
          placeholder="Type a command or search…"
          dir="auto"
          spellCheck={false}
          className="h-control-lg w-full bg-transparent pe-6 ps-11 text-body text-primary outline-hidden placeholder:text-tertiary"
        />
      </label>
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Commands and places"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-3"
      >
        {nothing ? (
          <p className="px-4 py-9 text-center text-body text-secondary">
            Nothing matches "<bdi>{query.trim()}</bdi>". Try fewer letters.
          </p>
        ) : null}
        {actionRows.length > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox (ARIA), not a form fieldset.
          <div role="group" aria-label="Actions" className="flex flex-col">
            <p className="px-4 pb-2 pt-3 text-small font-medium text-tertiary">Actions</p>
            {actionRows.map((row) =>
              row.kind === "action" ? (
                <div key={rowId(row)} {...optionProps(row)}>
                  <span
                    className={`min-w-0 flex-1 truncate text-body ${row.unavailable ? "text-tertiary" : "text-primary"}`}
                  >
                    {row.action.label}
                    {row.unavailable ? <span className="ms-4 text-small">{row.unavailable}</span> : null}
                  </span>
                  {row.action.keys ? (
                    <span className="flex shrink-0 gap-1" aria-hidden="true">
                      {row.action.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  ) : null}
                </div>
              ) : null,
            )}
          </div>
        ) : null}
        {goRows.length > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox (ARIA), not a form fieldset.
          <div role="group" aria-label="Go to" className="flex flex-col">
            <p className="px-4 pb-2 pt-3 text-small font-medium text-tertiary">Go to</p>
            {goRows.map((row) =>
              row.kind === "go" ? (
                <div key={rowId(row)} {...optionProps(row)}>
                  <span className="flex min-w-0 flex-1 items-baseline gap-4">
                    <span dir="auto" className="min-w-0 truncate text-body text-primary">
                      {row.item.label}
                    </span>
                    {row.item.context ? (
                      <span dir="auto" className="min-w-0 truncate text-small text-tertiary">
                        {row.item.context}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-small text-secondary">{row.item.kind}</span>
                </div>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
      <footer className="flex shrink-0 items-center gap-6 border-t border-hairline bg-subtle px-6 py-3 text-small text-secondary">
        <span className="flex items-center gap-2">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> Move
        </span>
        <span className="flex items-center gap-2">
          <Kbd>Enter</Kbd> Run or open
        </span>
        <span className="flex items-center gap-2">
          <Kbd>⌘</Kbd>
          <Kbd>Enter</Kbd> Show in the inspector
        </span>
        <span className="ms-auto flex items-center gap-2">
          <Kbd>Esc</Kbd> Close
        </span>
      </footer>
    </div>
  );
}
