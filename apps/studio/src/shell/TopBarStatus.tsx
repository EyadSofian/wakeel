import { Button } from "@wakeel/ui";
import { CircleAlert, Play, Rocket, Search, TriangleAlert } from "lucide-react";
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
      {/* Testing arrives with the emulator (4.6) and publishing with versions (7.1). */}
      <Button
        icon={<Play className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
        disabled
        title="Testing is not available yet"
      >
        Test
      </Button>
      <Button
        variant="primary"
        icon={<Rocket className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
        disabled
        title="Publishing is not available yet"
      >
        Publish
      </Button>
    </div>
  );
}
