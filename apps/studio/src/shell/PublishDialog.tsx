import { diffDefinitions } from "@wakeel/contracts";
import { Banner, Button, Dialog, Field, Input, Skeleton, Textarea } from "@wakeel/ui";
import { type FormEvent, useMemo, useState } from "react";
import { fieldErrors } from "../api/client";
import { usePublish, useVersion, useVersions } from "../api/versions";
import { useCanvasStore } from "../canvas/context";
import { waitForSaved } from "../emulator/run-from";
import { changeLines } from "../routes/versions/model";
import { useDraftDefinition } from "../routes/versions/use-draft";
import { ProblemBanner } from "./ProblemBanner";
import { useShell, useShellState } from "./shell-store";

/**
 * Publish (design system §5.8, task 7.5): a label, notes, what changed since the live version, and
 * the problems that block it. The draft is saved first, since the api publishes what it has stored.
 */
export function PublishDialog() {
  const { store, workspaceId, botId, issues } = useShell();
  const open = useShellState((s) => s.publish);
  const canvas = useCanvasStore();
  const publish = usePublish(workspaceId, botId);
  const versions = useVersions(workspaceId, botId);
  const live = versions.data?.find((v) => v.live);
  const liveVersion = useVersion(workspaceId, botId, live?.id);
  const draft = useDraftDefinition();
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const errors = (issues ?? []).filter((i) => i.severity === "error");
  const lines = useMemo(
    () =>
      liveVersion.data && draft ? changeLines(diffDefinitions(liveVersion.data.definition, draft).summary) : undefined,
    [liveVersion.data, draft],
  );
  const next = (versions.data?.[0]?.number ?? 0) + 1;
  const fields = fieldErrors(publish.error);

  const close = () => {
    publish.reset();
    setLabel("");
    setNotes("");
    store.getState().set({ publish: false });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await waitForSaved(canvas);
    } finally {
      setSaving(false);
    }
    publish.mutate({ label, ...(notes.trim() ? { notes } : {}) }, { onSuccess: close });
  };
  const blocked = errors.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={`Publish v${next}`}
      description="Live conversations move to this version at their next message. The emulator keeps running the draft."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="publish-form"
            disabled={blocked || publish.isPending || saving || label.trim() === ""}
          >
            Publish
          </Button>
        </>
      }
    >
      <form id="publish-form" onSubmit={submit} className="flex flex-col gap-6">
        <Field label="Label" help="What this version changes, in a few words." error={fields["label"]}>
          {(p) => (
            <Input
              {...p}
              dir="auto"
              value={label}
              maxLength={80}
              placeholder="Refund flow v2"
              onChange={(e) => setLabel(e.target.value)}
            />
          )}
        </Field>
        <Field label="Notes" help="Optional. Shown in the versions list." error={fields["notes"]}>
          {(p) => <Textarea {...p} dir="auto" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        <section aria-label="Changes since the live version" className="flex flex-col gap-3">
          <h3 className="text-small font-medium text-primary">
            {live ? `Changes since v${live.number}, the live version` : "Changes"}
          </h3>
          {!versions.data || (live && !lines) ? (
            <Skeleton className="h-4 w-1/2" />
          ) : !live ? (
            <p className="text-body text-secondary">Nothing is live yet. This becomes the first live version.</p>
          ) : lines && lines.length === 0 ? (
            <p className="text-body text-secondary">The draft behaves exactly like v{live.number}.</p>
          ) : (
            <dl className="flex flex-col gap-2 text-body">
              {(lines ?? []).map((l) => (
                <div key={l.label} className="flex gap-6">
                  <dt className="w-3/12 shrink-0 text-secondary">{l.label}</dt>
                  <dd className="text-primary">{l.detail}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        {blocked ? (
          <Banner
            tone="error"
            title={errors.length === 1 ? "1 problem blocks publishing" : `${errors.length} problems block publishing`}
          >
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1">
                {errors.slice(0, 3).map((i) => (
                  <li key={`${i.code}:${i.path}`} dir="auto">
                    {i.message}
                  </li>
                ))}
              </ul>
              <Button
                size="compact"
                className="self-start"
                onClick={() => {
                  close();
                  store.getState().set({ issuesPanel: true });
                }}
              >
                Show issues
              </Button>
            </div>
          </Banner>
        ) : null}
        {publish.isError && Object.keys(fields).length === 0 ? <ProblemBanner error={publish.error} /> : null}
      </form>
    </Dialog>
  );
}
