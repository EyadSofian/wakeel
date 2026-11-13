import { useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { useWorkspaces } from "../api/queries";

/**
 * The workspace name in the top bar (design system §5.4, "Engosoft ▾"). A native select: it is
 * keyboard-complete and announced correctly without a custom listbox. Names are user-written, so
 * they render with dir="auto".
 */
export function WorkspaceSwitcher({ workspaceId }: { workspaceId: string }) {
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  const id = useId();
  const list = workspaces.data ?? [];
  const current = list.find((w) => w.id === workspaceId);
  if (list.length <= 1) {
    return (
      <span dir="auto" className="truncate">
        {current?.name ?? ""}
      </span>
    );
  }
  return (
    <>
      <label htmlFor={id} className="sr-only">
        Workspace
      </label>
      <select
        id={id}
        value={workspaceId}
        onChange={(e) => void navigate({ to: "/w/$workspaceId", params: { workspaceId: e.target.value } })}
        className="h-control-sm max-w-inspector-max truncate rounded-sm bg-transparent px-2 text-body font-medium text-primary hover:bg-subtle"
      >
        {list.map((w) => (
          <option key={w.id} value={w.id} dir="auto">
            {w.name}
          </option>
        ))}
      </select>
    </>
  );
}
