import { Kbd } from "@wakeel/ui";
import { X } from "lucide-react";
import { SHORTCUTS, type Shortcut } from "./shortcuts";
import { useUi, useUiStore } from "./ui-store";

const GROUPS: Shortcut["group"][] = ["Canvas", "Nodes", "Cards", "Transitions"];

/** The shortcut sheet (`?`, design system §5.1): every canvas shortcut, grouped. `Esc` or `?` closes. */
export function ShortcutSheet() {
  const open = useUi((s) => s.sheet);
  const ui = useUiStore();
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="nodrag nowheel absolute inset-x-0 top-12 z-40 mx-auto flex max-h-picker-height w-inspector-max flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-modal"
    >
      <header className="flex items-center justify-between border-b border-hairline px-7 py-5">
        <h2 className="text-title text-primary">Keyboard shortcuts</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => ui.getState().set({ sheet: false })}
          className="flex size-control-sm items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
        >
          <X className="size-icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="flex flex-col gap-6 overflow-auto px-7 py-6">
        {GROUPS.map((g) => (
          <section key={g} className="flex flex-col gap-2">
            <h3 className="text-small font-medium text-tertiary">{g}</h3>
            <dl className="flex flex-col">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div
                  key={s.id}
                  className="flex h-row items-center justify-between gap-6 border-b border-hairline last:border-b-0"
                >
                  <dt className="text-body text-primary">{s.action}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
