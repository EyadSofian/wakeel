import { Button } from "@wakeel/ui";
import { CircleAlert, Play, Rocket, Search, TriangleAlert } from "lucide-react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useEmulatorStoreOptional } from "../emulator/controller";
import { SaveIndicator } from "./SaveIndicator";
import { useShell } from "./shell-store";

const count = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

/**
 * The end of the bot's top bar (design system §5.1): the command palette, save state, the issue
 * count that opens the Issues panel, then Test and Publish.
 */
export function TopBarStatus() {
  const { store, issues } = useShell();
  const all = issues ?? [];
  const errors = all.filter((i) => i.severity === "error").length;
  const warnings = all.length - errors;
  return (
    <div className="flex items-center gap-5" data-validated={issues !== undefined}>
      <button
        type="button"
        aria-label="Command palette"
        title="Command palette (⌘K)"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => store.getState().set({ palette: true })}
        className="flex size-control items-center justify-center rounded-sm text-secondary transition-colors hover:bg-subtle hover:text-primary"
      >
        <Search className="size-icon" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <SaveIndicator />
      {all.length > 0 ? (
        <button
          type="button"
          onClick={() => store.getState().set({ issuesPanel: true })}
          aria-label={`${count(errors, "error")}, ${count(warnings, "warning")}. Show issues`}
          title="Show issues (F8 steps through them)"
          className="flex h-control-sm items-center gap-3 rounded-sm px-2 text-small text-secondary transition-colors hover:bg-subtle hover:text-primary"
        >
          {errors > 0 ? (
            <span className="flex items-center gap-1">
              <CircleAlert className="size-icon-sm text-error" strokeWidth={1.5} aria-hidden="true" />
              <span className="tabular-nums">{errors}</span>
            </span>
          ) : null}
          {warnings > 0 ? (
            <span className="flex items-center gap-1">
              <TriangleAlert className="size-icon-sm text-warning" strokeWidth={1.5} aria-hidden="true" />
              <span className="tabular-nums">{warnings}</span>
            </span>
          ) : null}
        </button>
      ) : null}
      <span aria-hidden="true" className="h-control-sm border-s border-hairline" />
      <TestButton />
      <Button
        variant="primary"
        icon={<Rocket className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
        title="Publish the draft (⇧⌘P)"
        aria-keyshortcuts="Shift+Meta+P Shift+Control+P"
        onClick={() => store.getState().set({ publish: true })}
      >
        Publish
      </Button>
    </div>
  );
}

/** Opens and closes the emulator (§5.3); off the canvas, where there is none, it is disabled. */
function TestButton() {
  const emulator = useEmulatorStoreOptional();
  const open = useStore(emulator ?? NO_EMULATOR, (s) => s.open);
  return (
    <Button
      icon={<Play className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
      aria-pressed={emulator ? open : undefined}
      disabled={!emulator}
      title={emulator ? (open ? "Close the emulator" : "Test the draft in the emulator") : "Open the canvas to test"}
      onClick={() => emulator?.getState().setOpen(!open)}
    >
      Test
    </Button>
  );
}

/** Stands in for a missing emulator so the hook order stays the same. */
const NO_EMULATOR = createStore(() => ({ open: false }));
