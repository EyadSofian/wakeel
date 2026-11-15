import { Field, Input, Skeleton } from "@wakeel/ui";
import { useEffect, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useUpdateWorkspace, useWorkspace } from "../../api/queries";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { SettingsLayout } from "./SettingsLayout";

/** Settings → General: the workspace's name and address. Only owners and admins may change them. */
export function General({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const update = useUpdateWorkspace(workspaceId);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (workspace.data) {
      setName(workspace.data.name);
      setSlug(workspace.data.slug);
    }
  }, [workspace.data]);
  const canEdit = workspace.data?.permissions.includes("workspace.update") ?? false;
  const errors = fieldErrors(update.error);

  /** Autosave (design system §3.2): a field saves when it loses focus or on Enter, if it changed. */
  const save = (field: "name" | "slug", value: string) => {
    if (!workspace.data || value === workspace.data[field]) return;
    setSaved(false);
    update.mutate({ [field]: value }, { onSuccess: () => setSaved(true) });
  };
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <SettingsLayout workspaceId={workspaceId} tab="general">
      <div className="flex max-w-inspector-max flex-col gap-6 rounded-lg border border-hairline bg-surface p-8">
        {workspace.isError ? <ProblemBanner error={workspace.error} /> : null}
        {workspace.isPending ? (
          <div className="flex flex-col gap-6" aria-busy="true">
            <Skeleton className="h-control w-full" />
            <Skeleton className="h-control w-full" />
          </div>
        ) : workspace.data ? (
          <div className="flex flex-col gap-6">
            {update.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={update.error} /> : null}
            <Field label="Name" error={errors["name"]}>
              {(p) => (
                <Input
                  {...p}
                  dir="auto"
                  value={name}
                  disabled={!canEdit}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => save("name", name)}
                  onKeyDown={onEnter}
                />
              )}
            </Field>
            <Field label="Address" help="Lower-case letters, digits and dashes." error={errors["slug"]}>
              {(p) => (
                <Input
                  {...p}
                  dir="ltr"
                  className="font-mono"
                  value={slug}
                  disabled={!canEdit}
                  onChange={(e) => setSlug(e.target.value)}
                  onBlur={() => save("slug", slug)}
                  onKeyDown={onEnter}
                />
              )}
            </Field>
            <p role="status" className="text-small text-secondary">
              {canEdit
                ? update.isPending
                  ? "Saving…"
                  : saved
                    ? "Saved"
                    : "Changes save when you leave a field."
                : "Only owners and admins can change these."}
            </p>
          </div>
        ) : null}
      </div>
    </SettingsLayout>
  );
}
