import { type ConfigEnv, ConfigVar, type ConfigVariableResponse } from "@wakeel/contracts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  Table,
  Td,
  THead,
  Th,
  Tr,
} from "@wakeel/ui";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useConfigVars, useDeleteConfigValue, useSetConfigValue } from "../../api/versions";
import { useCanvas, useCanvasStore } from "../../canvas/context";
import { waitForSaved } from "../../emulator/run-from";
import { ProblemBanner } from "../../shell/ProblemBanner";

const ENVS: { env: ConfigEnv; label: string }[] = [
  { env: "draft", label: "Draft" },
  { env: "production", label: "Production" },
];
const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

type Editing = { variable: ConfigVariableResponse; env: ConfigEnv };

/**
 * Secrets and settings (design system §5.7, task 7.5, ADR-037): config variables the bot reads as
 * `env.<KEY>`, each with a Draft value (emulator and draft connections) and a Production value (live
 * conversations). Secret values are write-only: once set, only "Set" and the date show.
 */
export function SecretsTab({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const config = useConfigVars(workspaceId, botId);
  const declared = useCanvas((s) => s.manifest?.doc.configVars);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Editing>();
  const clear = useDeleteConfigValue(workspaceId, botId);
  const store = useCanvasStore();
  // Declarations live in the draft (the canvas store), values on the server; show both at once.
  const rows: ConfigVariableResponse[] = [
    ...(config.data ?? []),
    ...(declared ?? [])
      .filter((d) => !(config.data ?? []).some((c) => c.key === d.key))
      .map((d) => ({
        key: d.key,
        secret: d.secret,
        description: d.description ?? null,
        declared: true,
        draft: { set: false, value: null, updatedAt: null },
        production: { set: false, value: null, updatedAt: null },
      })),
  ].map((r) => {
    const d = declared?.find((x) => x.key === r.key);
    return d
      ? { ...r, secret: d.secret, description: d.description ?? null, declared: true }
      : { ...r, declared: false };
  });
  const undeclare = (key: string) =>
    store.getState().updateManifest((m) => ({ ...m, configVars: m.configVars.filter((c) => c.key !== key) }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-6">
        <p className="text-body text-secondary">
          Code reads these as <code className="font-mono text-code-small">env.KEY</code>. Draft values serve the
          emulator; production values serve live conversations.
        </p>
        <Button
          size="compact"
          icon={<Plus className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => setAdding(true)}
        >
          Add config variable
        </Button>
      </div>
      {config.isError ? (
        <ProblemBanner error={config.error} />
      ) : config.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading config variables" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-control w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No config variables yet"
          detail="Add one for each API address, token or switch the bot's code needs, so values stay out of the code."
        />
      ) : (
        <Table label="Config variables" fixed>
          <THead>
            <tr>
              <Th className="w-4/12">Key</Th>
              <Th className="w-1/12">Kind</Th>
              <Th className="w-3/12">Draft</Th>
              <Th className="w-3/12">Production</Th>
              <Th className="w-1/12">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((v) => (
              <Tr key={v.key}>
                <Td>
                  <span className="flex min-w-0 flex-col">
                    <span dir="ltr" className="truncate font-mono text-code-small text-primary">
                      {v.key}
                    </span>
                    {v.description ? (
                      // bdi, not dir="auto": Arabic keeps its direction but stays at the column's start.
                      <span className="truncate text-small text-secondary">
                        <bdi>{v.description}</bdi>
                      </span>
                    ) : null}
                    {v.declared ? null : <span className="text-small text-warning">Not declared any more</span>}
                  </span>
                </Td>
                <Td className="text-secondary">{v.secret ? "Secret" : "Setting"}</Td>
                {ENVS.map(({ env, label }) => (
                  <Td key={env}>
                    <ValueCell
                      variable={v}
                      env={env}
                      envLabel={label}
                      onEdit={() => setEditing({ variable: v, env })}
                      onClear={() => clear.mutate({ env, key: v.key })}
                    />
                  </Td>
                ))}
                <Td>
                  {v.declared ? (
                    <Button
                      size="compact"
                      variant="ghost"
                      aria-label={`Remove ${v.key}`}
                      title="Remove the declaration; stored values stay until cleared"
                      icon={<Trash2 className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
                      onClick={() => undeclare(v.key)}
                    />
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {clear.isError ? <ProblemBanner error={clear.error} /> : null}
      <DeclareDialog open={adding} onClose={() => setAdding(false)} />
      <ValueDialog workspaceId={workspaceId} botId={botId} editing={editing} onClose={() => setEditing(undefined)} />
    </div>
  );
}

function ValueCell({
  variable: v,
  env,
  envLabel,
  onEdit,
  onClear,
}: {
  variable: ConfigVariableResponse;
  env: ConfigEnv;
  envLabel: string;
  onEdit: () => void;
  onClear: () => void;
}) {
  const state = v[env];
  if (!v.declared) {
    return state.set ? (
      <Button size="compact" variant="ghost" onClick={onClear} aria-label={`Clear ${v.key} for ${envLabel}`}>
        Clear
      </Button>
    ) : (
      <span className="text-tertiary">Not set</span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-3">
      {!state.set ? (
        <span className="text-tertiary">Not set</span>
      ) : v.secret ? (
        <span className="flex items-center gap-2 text-secondary">
          <KeyRound className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
          <Badge>Set</Badge>
          {state.updatedAt ? <span className="text-small">{date.format(new Date(state.updatedAt))}</span> : null}
        </span>
      ) : (
        <span dir="auto" className="truncate text-primary">
          {state.value}
        </span>
      )}
      <Button size="compact" variant="ghost" onClick={onEdit} aria-label={`Set ${v.key} for ${envLabel}`}>
        {state.set ? "Change" : "Set"}
      </Button>
    </span>
  );
}

/** Declares a config variable in the draft manifest; values are set per environment afterwards. */
function DeclareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useCanvasStore();
  const declared = useCanvas((s) => s.manifest?.doc.configVars);
  const taken = (declared ?? []).map((c) => c.key);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState(true);
  const [description, setDescription] = useState("");
  const parsed = ConfigVar.safeParse({ key, secret, ...(description.trim() ? { description } : {}) });
  const error =
    key === ""
      ? undefined
      : !parsed.success
        ? "Use upper-case letters, digits and underscores, starting with a letter."
        : taken.includes(key)
          ? `${key} is already declared.`
          : undefined;
  const close = () => {
    setKey("");
    setSecret(true);
    setDescription("");
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.success || error) return;
    store.getState().updateManifest((m) => ({ ...m, configVars: [...m.configVars, parsed.data] }));
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Add config variable"
      description="The bot's code reads it as env.KEY. Set its values for Draft and Production next."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="declare-config" disabled={key === "" || error !== undefined}>
            Add config variable
          </Button>
        </>
      }
    >
      <form id="declare-config" onSubmit={submit} className="flex flex-col gap-6">
        <Field label="Key" help="For example SHOP_URL or SHOP_TOKEN." {...(error ? { error } : {})}>
          {(p) => (
            <Input
              {...p}
              dir="ltr"
              className="font-mono"
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Switch
          label="Secret"
          hint="Values can be set and replaced but never read back, and are kept out of traces."
          checked={secret}
          onChange={setSecret}
        />
        <Field label="Description" help="Optional. Shown under the key.">
          {(p) => <Input {...p} dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

/** Sets one environment's value. The declaration is saved first, since the api checks it. */
function ValueDialog({
  workspaceId,
  botId,
  editing,
  onClose,
}: {
  workspaceId: string;
  botId: string;
  editing: Editing | undefined;
  onClose: () => void;
}) {
  const set = useSetConfigValue(workspaceId, botId);
  const store = useCanvasStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const env = editing ? ENVS.find((e) => e.env === editing.env)?.label : "";
  const secret = editing?.variable.secret ?? true;
  const errors = fieldErrors(set.error);
  const close = () => {
    set.reset();
    setValue("");
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await waitForSaved(store);
    } finally {
      setSaving(false);
    }
    set.mutate({ env: editing.env, key: editing.variable.key, value }, { onSuccess: close });
  };
  return (
    <Dialog
      open={editing !== undefined}
      onOpenChange={(o) => !o && close()}
      title={editing ? `Set ${editing.variable.key} for ${env}` : "Set value"}
      {...(secret ? { description: "The value is stored encrypted. It can be replaced but not shown again." } : {})}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="config-value" disabled={set.isPending || saving}>
            Set value
          </Button>
        </>
      }
    >
      <form id="config-value" onSubmit={submit} className="flex flex-col gap-6">
        <Field label="Value" {...(errors["value"] ? { error: errors["value"] } : {})}>
          {(p) => (
            <Input
              {...p}
              dir={secret ? "ltr" : "auto"}
              type={secret ? "password" : "text"}
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        {set.isError && !errors["value"] ? <ProblemBanner error={set.error} /> : null}
      </form>
    </Dialog>
  );
}
