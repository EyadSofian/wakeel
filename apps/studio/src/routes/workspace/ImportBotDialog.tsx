import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { BotResponse, ExternalReference } from "@wakeel/contracts";
import { Banner, Button, Dialog, Field, Input } from "@wakeel/ui";
import { FileUp } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { api, fieldErrors } from "../../api/client";
import { botKeys } from "../../api/queries";
import { slugFrom } from "../../lib/slug";
import { ProblemBanner } from "../../shell/ProblemBanner";

/**
 * Import bot (task 7.6, ADR-038): a `.wakeel.json` export becomes a new bot with new ids. Knowledge
 * bases and tables it names are listed afterwards, since they do not travel with the file.
 */
export function ImportBotDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [file, setFile] = useState<unknown>();
  const [fileName, setFileName] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string>();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const importBot = useMutation({
    mutationFn: (body: { name: string; slug: string; file: unknown }) =>
      api<{ bot: BotResponse; unresolved: ExternalReference[] }>(
        "POST",
        `/v1/workspaces/${workspaceId}/bots/import`,
        body,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: botKeys.list(workspaceId) }),
  });
  const errors = fieldErrors(importBot.error);
  const done = importBot.data;
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      importBot.reset();
      setFile(undefined);
      setFileName(undefined);
      setFileError(undefined);
      setName("");
      setSlug("");
    }
  };
  const open_ = (botId: string) => void navigate({ to: "/w/$workspaceId/b/$botId", params: { workspaceId, botId } });
  const read = async (f: File | undefined) => {
    setFileError(undefined);
    setFile(undefined);
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text()) as { definition?: { manifest?: { name?: string } } };
      setFile(parsed);
      const suggested = parsed.definition?.manifest?.name;
      if (suggested && name === "") {
        setName(suggested);
        setSlug(slugFrom(suggested));
      }
    } catch {
      setFileError("This file is not JSON. Choose the .wakeel.json file an export downloaded.");
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file !== undefined) importBot.mutate({ name, slug, file });
  };

  if (done) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Bot imported"
        description={`${done.bot.name} is ready as a draft with new ids.`}
        footer={
          <Button variant="primary" size="large" onClick={() => open_(done.bot.id)}>
            Open bot
          </Button>
        }
      >
        {done.unresolved.length > 0 ? (
          <Banner tone="warning" title="Point these at this workspace's own resources">
            <ul className="flex flex-col gap-1">
              {done.unresolved.map((r) => (
                <li key={r.id}>
                  {r.kind === "knowledge_base" ? "Knowledge base" : "Table"}{" "}
                  <span dir="ltr" className="font-mono text-code-small">
                    {r.id}
                  </span>
                </li>
              ))}
            </ul>
          </Banner>
        ) : (
          <p className="text-body text-secondary">
            Config variable values never travel with an export; set them on the Variables screen.
          </p>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Import bot"
      description="Creates a new bot from an exported file. Versions, secrets and conversations are not included."
      footer={
        <>
          <Button size="large" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="import-bot-form"
            variant="primary"
            size="large"
            disabled={importBot.isPending || file === undefined}
          >
            Import bot
          </Button>
        </>
      }
    >
      <form id="import-bot-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {importBot.isError && !errors["name"] && !errors["slug"] && !errors["file"] ? (
          <ProblemBanner error={importBot.error} />
        ) : null}
        <Field label="File" help="The .wakeel.json file from Export bot." error={fileError ?? errors["file"]}>
          {(p) => (
            <span className="flex items-center gap-4">
              {/* The native control stays for the label and screen readers; the visible button takes focus and opens it. */}
              <input
                {...p}
                ref={picker}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  setFileName(e.target.files?.[0]?.name);
                  void read(e.target.files?.[0]);
                }}
              />
              <Button
                icon={<FileUp className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
                onClick={() => picker.current?.click()}
              >
                Choose file
              </Button>
              <span dir="auto" className={`truncate text-body ${fileName ? "text-primary" : "text-tertiary"}`}>
                {fileName ?? "No file chosen"}
              </span>
            </span>
          )}
        </Field>
        <Field label="Name" error={errors["name"]}>
          {(p) => <Input {...p} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Address" help="Lower-case letters, digits and dashes." error={errors["slug"]}>
          {(p) => (
            <Input {...p} dir="ltr" className="font-mono" value={slug} onChange={(e) => setSlug(e.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
