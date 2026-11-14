import { CircleCheck, CloudOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { useCanvas } from "../canvas/context";
import { isDirty } from "../canvas/store/store";

export type SaveState = "saved" | "saving" | "offline" | "conflict";

/** One state for every draft document of the bot: the worst one wins. */
export function useSaveState(): SaveState {
  return useCanvas((s) => {
    const docs = [s.manifest, ...Object.values(s.workflows)];
    if (docs.some((d) => d?.conflict)) return "conflict";
    if (docs.some((d) => d?.error)) return "offline";
    if (docs.some((d) => d && (d.saving || isDirty(d)))) return "saving";
    return "saved";
  });
}

const LABELS: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  offline: "Offline — changes kept locally",
  conflict: "Changed elsewhere",
};

/**
 * SaveIndicator (design system §4 Shell): "Saved", "Saving…", "Offline — changes kept locally",
 * and "Changed elsewhere" while a revision conflict waits. Autosave is the only save (§3.2), so this
 * is status, not a button; a live region announces each change.
 */
export function SaveIndicator() {
  const state = useSaveState();
  const Icon = { saved: CircleCheck, saving: LoaderCircle, offline: CloudOff, conflict: TriangleAlert }[state];
  const tone = state === "saved" ? "text-success" : state === "saving" ? "text-tertiary" : "text-warning";
  return (
    <span
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 text-small ${state === "offline" || state === "conflict" ? "text-warning" : "text-secondary"}`}
    >
      <Icon className={`size-icon-sm ${tone}`} strokeWidth={1.75} aria-hidden="true" />
      {LABELS[state]}
    </span>
  );
}
