import type { ModelKeyStatus, ModelProvider } from "@wakeel/contracts";
import { Badge, Button, Dialog, EmptyState, Field, Input, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { type FormEvent, useEffect, useState } from "react";
import { fieldErrors } from "../../../api/client";
import { useDeleteModelKey, useModelDefaults, useModelKeys, useModels, usePutModelKey } from "../../../api/models";
import { useWorkspace } from "../../../api/queries";
import { ProblemBanner } from "../../../shell/ProblemBanner";
import { SettingsLayout } from "../../workspace/SettingsLayout";
import { ModelPicker, PROVIDER_LABELS } from "./ModelPicker";

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/**
 * Settings → Models (task 6.2, design system §5.13): the provider keys this workspace brings, which
 * are write-only, and the default and utility models. Owners and admins manage keys.
 */
export function ModelsSettings({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const canKeys = workspace.data?.permissions.includes("secret.read") ?? false;
  const canDefaults = workspace.data?.permissions.includes("workspace.update") ?? false;
  return (
    <SettingsLayout workspaceId={workspaceId} tab="models">
      <div className="flex flex-col gap-10">
        {workspace.isError ? (
          <div>
            <ProblemBanner error={workspace.error} />
          </div>
        ) : workspace.data && !canKeys ? (
          <EmptyState
            title="Only owners and admins manage models"
            detail="Ask one of them to add a provider key or change the defaults."
          />
        ) : (
          <>
            <ProviderKeys workspaceId={workspaceId} enabled={canKeys} />
            <Defaults workspaceId={workspaceId} canEdit={canDefaults} />
          </>
        )}
      </div>
    </SettingsLayout>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-5" aria-label={title}>
      <div className="flex flex-col gap-1">
        <h2 className="text-title text-primary">{title}</h2>
        <p className="text-body text-secondary">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ProviderKeys({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }) {
  const keys = useModelKeys(workspaceId, enabled);
  const remove = useDeleteModelKey(workspaceId);
  const [editing, setEditing] = useState<ModelProvider>();
  const [removing, setRemoving] = useState<ModelProvider>();
  return (
    <Section
      title="Provider keys"
      description="Your own keys for each model provider. They are stored encrypted and never shown again; only their last four characters are."
    >
      {keys.isError ? (
        <ProblemBanner error={keys.error} />
      ) : (
        <Table label="Provider keys">
          <THead>
            <tr>
              <Th>Provider</Th>
              <Th>Key</Th>
              <Th>Updated</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {keys.isPending
              ? [0, 1, 2, 3].map((i) => (
                  <Tr key={i} aria-hidden="true">
                    {[0, 1, 2, 3].map((c) => (
                      <Td key={c}>
                        <Skeleton className="h-3 w-12" />
                      </Td>
                    ))}
                  </Tr>
                ))
              : (keys.data ?? []).map((k) => (
                  <KeyRow
                    key={k.provider}
                    status={k}
                    onSet={() => setEditing(k.provider)}
                    onRemove={() => setRemoving(k.provider)}
                    removing={remove.isPending}
                  />
                ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={removing !== undefined}
        onOpenChange={(o) => {
          if (!o) {
            remove.reset();
            setRemoving(undefined);
          }
        }}
        title={removing ? `Remove the ${PROVIDER_LABELS[removing]} key?` : ""}
        description="Bots that use this provider stop working until a key is added again. This cannot be undone."
        footer={
          <>
            <Button size="large" onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="large"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing, { onSuccess: () => setRemoving(undefined) })}
            >
              Remove key
            </Button>
          </>
        }
      >
        {remove.isError ? <ProblemBanner error={remove.error} /> : <span className="sr-only">Confirm removing</span>}
      </Dialog>
      <KeyDialog workspaceId={workspaceId} provider={editing} onClose={() => setEditing(undefined)} />
    </Section>
  );
}

function KeyRow({
  status: k,
  onSet,
  onRemove,
  removing,
}: {
  status: ModelKeyStatus;
  onSet: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <Tr>
      <Td className="font-medium">{PROVIDER_LABELS[k.provider]}</Td>
      <Td>
        {k.set ? (
          <span className="flex items-center gap-3">
            <code dir="ltr" className="font-mono text-code-small text-secondary">
              …{k.last4}
            </code>
            {k.baseUrl ? (
              <span dir="ltr" className="truncate text-small text-tertiary">
                {k.baseUrl}
              </span>
            ) : null}
          </span>
        ) : (
          <Badge>Not set</Badge>
        )}
      </Td>
      <Td className="text-secondary">{k.updatedAt ? date.format(new Date(k.updatedAt)) : "—"}</Td>
      <Td className="text-end">
        <span className="flex justify-end gap-3">
          <Button
            variant="ghost"
            size="compact"
            onClick={onSet}
            aria-label={`${k.set ? "Replace" : "Add"} the ${PROVIDER_LABELS[k.provider]} key`}
          >
            {k.set ? "Replace" : "Add key"}
          </Button>
          {k.set ? (
            <Button
              variant="ghost"
              size="compact"
              disabled={removing}
              onClick={onRemove}
              aria-label={`Remove the ${PROVIDER_LABELS[k.provider]} key`}
            >
              Remove
            </Button>
          ) : null}
        </span>
      </Td>
    </Tr>
  );
}

function KeyDialog({
  workspaceId,
  provider,
  onClose,
}: {
  workspaceId: string;
  provider: ModelProvider | undefined;
  onClose: () => void;
}) {
  const put = usePutModelKey(workspaceId);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const errors = fieldErrors(put.error);
  const close = () => {
    put.reset();
    setApiKey("");
    setBaseUrl("");
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    put.mutate(
      { provider, apiKey, ...(provider === "openai-compatible" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) },
      { onSuccess: close },
    );
  };
  return (
    <Dialog
      open={provider !== undefined}
      onOpenChange={(o) => !o && close()}
      title={provider ? `${PROVIDER_LABELS[provider]} key` : ""}
      description="Paste the key from the provider's console. It is stored encrypted and cannot be shown again."
      footer={
        <>
          <Button size="large" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="model-key-form" variant="primary" size="large" disabled={put.isPending}>
            Save key
          </Button>
        </>
      }
    >
      <form id="model-key-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {put.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={put.error} /> : null}
        <Field label="API key" error={errors["apiKey"]}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              dir="ltr"
              className="font-mono"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
        {provider === "openai-compatible" ? (
          <Field
            label="Server address"
            help="The https address of the server's OpenAI-compatible API."
            error={errors["baseUrl"]}
          >
            {(p) => (
              <Input
                {...p}
                dir="ltr"
                inputMode="url"
                placeholder="https://"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            )}
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

function Defaults({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const workspace = useWorkspace(workspaceId);
  const models = useModels(workspaceId);
  const save = useModelDefaults(workspaceId);
  const settings = workspace.data?.settings as { defaultModel?: string; utilityModel?: string } | undefined;
  const [defaultModel, setDefault] = useState<string | null>(null);
  const [utilityModel, setUtility] = useState<string | null>(null);
  const errors = fieldErrors(save.error);
  useEffect(() => {
    setDefault(settings?.defaultModel ?? null);
    setUtility(settings?.utilityModel ?? null);
  }, [settings?.defaultModel, settings?.utilityModel]);

  return (
    <Section
      title="Defaults"
      description="The model a step uses when it names none, and a cheaper one for summaries and quick checks."
    >
      {models.isError ? <ProblemBanner error={models.error} /> : null}
      {save.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={save.error} /> : null}
      {models.isPending ? (
        <div className="flex max-w-inspector-max flex-col gap-6" aria-hidden="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : models.data ? (
        <form
          className="flex max-w-inspector-max flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ defaultModel, utilityModel });
          }}
        >
          <Field
            label="Default model"
            help="Used by Autonomous Nodes and AI cards that do not choose one."
            error={errors["defaultModel"]}
          >
            {(p) => (
              <ModelPicker
                {...p}
                models={models.data}
                value={defaultModel}
                onValueChange={setDefault}
                disabled={!canEdit}
                allowNone="None"
              />
            )}
          </Field>
          <Field
            label="Utility model"
            help="Used for handoff summaries and conversation summaries."
            error={errors["utilityModel"]}
          >
            {(p) => (
              <ModelPicker
                {...p}
                models={models.data}
                value={utilityModel}
                onValueChange={setUtility}
                disabled={!canEdit}
                allowNone="None"
              />
            )}
          </Field>
          {canEdit ? (
            <div>
              <Button type="submit" variant="primary" disabled={save.isPending}>
                Save defaults
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </Section>
  );
}
