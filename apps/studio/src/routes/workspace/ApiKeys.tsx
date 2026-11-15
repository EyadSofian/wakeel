import type { ApiKeyResponse } from "@wakeel/contracts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Td,
  THead,
  Th,
  Tr,
} from "@wakeel/ui";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useWorkspace } from "../../api/queries";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { SettingsLayout } from "./SettingsLayout";

/**
 * Access levels offered when creating a key. Each is a set of scopes from the permission matrix
 * (docs/security/rbac.md); keys can never manage people, keys or secrets.
 */
export const ACCESS_LEVELS = {
  read: {
    label: "Read only",
    help: "Read bots, conversations, usage and the audit log.",
    scopes: ["workspace.read", "member.read", "bot.read", "conversation.read", "usage.read", "audit.read"],
  },
  build: {
    label: "Build and publish",
    help: "Everything in read only, plus create, change and publish bots, manage connections and run evals.",
    scopes: [
      "workspace.read",
      "member.read",
      "bot.read",
      "conversation.read",
      "usage.read",
      "audit.read",
      "bot.create",
      "bot.update",
      "bot.delete",
      "bot.publish",
      "connection.read",
      "connection.manage",
      "eval.run",
    ],
  },
} as const;
type Access = keyof typeof ACCESS_LEVELS;

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const accessOf = (k: ApiKeyResponse) =>
  k.scopes.includes("bot.update") ? ACCESS_LEVELS.build.label : ACCESS_LEVELS.read.label;

/** Settings → API keys: list, create (the key is shown once), revoke. Owners and admins only. */
export function ApiKeys({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const canRead = workspace.data?.permissions.includes("api_key.read") ?? false;
  const keys = useApiKeys(workspaceId, canRead);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyResponse | undefined>();
  const active = (keys.data ?? []).filter((k) => k.revokedAt === null);
  const icon = <KeyRound className="size-icon" strokeWidth={1.5} aria-hidden="true" />;

  return (
    <SettingsLayout
      workspaceId={workspaceId}
      tab="api-keys"
      actions={
        canRead ? (
          <Button variant="primary" icon={icon} onClick={() => setCreateOpen(true)}>
            New API key
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-6">
        {workspace.isError ? (
          <div>
            <ProblemBanner error={workspace.error} />
          </div>
        ) : workspace.data && !canRead ? (
          <EmptyState
            title="Only owners and admins manage API keys"
            detail="Ask one of them to create a key for you."
          />
        ) : keys.isError ? (
          <div>
            <ProblemBanner error={keys.error} />
          </div>
        ) : keys.data && keys.data.length === 0 ? (
          <EmptyState title="No API keys yet" detail="Keys let scripts and CI call this workspace's API." />
        ) : (
          <Table label="API keys">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Access</Th>
                <Th>Last used</Th>
                <Th>Created</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody>
              {keys.isPending || !workspace.data
                ? [0, 1, 2].map((i) => (
                    <Tr key={i} aria-hidden="true">
                      {[0, 1, 2, 3, 4, 5].map((c) => (
                        <Td key={c}>
                          <Skeleton className="h-3 w-12" />
                        </Td>
                      ))}
                    </Tr>
                  ))
                : [...active, ...(keys.data ?? []).filter((k) => k.revokedAt !== null)].map((k) => (
                    <Tr key={k.id} className={k.revokedAt === null ? "" : "text-tertiary"}>
                      <Td className="max-w-node">
                        <span dir="auto" className="block truncate font-medium">
                          {k.name}
                        </span>
                      </Td>
                      <Td>
                        <code dir="ltr" className="text-code-small text-secondary">
                          {k.prefix}_…
                        </code>
                      </Td>
                      <Td className="text-secondary">{accessOf(k)}</Td>
                      <Td className="text-secondary">
                        {k.lastUsedAt ? dateFormat.format(new Date(k.lastUsedAt)) : "Never"}
                      </Td>
                      <Td className="text-secondary">{dateFormat.format(new Date(k.createdAt))}</Td>
                      <Td className="text-end">
                        {k.revokedAt === null ? (
                          <Button variant="ghost" size="compact" onClick={() => setRevoking(k)}>
                            Revoke
                          </Button>
                        ) : (
                          <Badge>Revoked</Badge>
                        )}
                      </Td>
                    </Tr>
                  ))}
            </tbody>
          </Table>
        )}
      </div>
      <CreateKeyDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} />
      <RevokeKeyDialog workspaceId={workspaceId} apiKey={revoking} onClose={() => setRevoking(undefined)} />
    </SettingsLayout>
  );
}

function CreateKeyDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateApiKey(workspaceId);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [copied, setCopied] = useState(false);
  const errors = fieldErrors(create.error);
  const key = create.data?.key;

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      create.reset();
      setName("");
      setAccess("read");
      setCopied(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name, scopes: [...ACCESS_LEVELS[access].scopes] });
  };

  if (key !== undefined) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Copy your key"
        description="This is the only time it is shown. Store it somewhere safe; if it is lost, revoke it and create another."
        footer={
          <>
            <Button
              size="large"
              onClick={() => {
                void navigator.clipboard?.writeText(key).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy key"}
            </Button>
            <Button variant="primary" size="large" onClick={() => close(false)}>
              Done
            </Button>
          </>
        }
      >
        <Field label="API key">
          {(p) => (
            <Input
              {...p}
              readOnly
              dir="ltr"
              className="font-mono"
              data-testid="new-api-key"
              value={key}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </Field>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New API key"
      footer={
        <>
          <Button size="large" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="key-form" variant="primary" size="large" disabled={create.isPending}>
            Create key
          </Button>
        </>
      }
    >
      <form id="key-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {create.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={create.error} /> : null}
        <Field label="Name" help="Where it is used, for example GitHub Actions." error={errors["name"]}>
          {(p) => <Input {...p} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Access" help={ACCESS_LEVELS[access].help} error={errors["scopes"]}>
          {(p) => (
            <Select {...p} value={access} onChange={(e) => setAccess(e.target.value as Access)}>
              {(Object.keys(ACCESS_LEVELS) as Access[]).map((a) => (
                <option key={a} value={a}>
                  {ACCESS_LEVELS[a].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function RevokeKeyDialog({
  workspaceId,
  apiKey,
  onClose,
}: {
  workspaceId: string;
  apiKey: ApiKeyResponse | undefined;
  onClose: () => void;
}) {
  const revoke = useRevokeApiKey(workspaceId);
  return (
    <Dialog
      open={apiKey !== undefined}
      onOpenChange={(o) => {
        if (!o) {
          revoke.reset();
          onClose();
        }
      }}
      title={`Revoke key "${apiKey?.name ?? ""}"?`}
      description="Anything using it stops working at once. This cannot be undone."
      footer={
        <>
          <Button size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="large"
            disabled={revoke.isPending}
            onClick={() => apiKey && revoke.mutate(apiKey.id, { onSuccess: onClose })}
          >
            Revoke key
          </Button>
        </>
      }
    >
      {revoke.isError ? <ProblemBanner error={revoke.error} /> : <span className="sr-only">Confirm revoking</span>}
    </Dialog>
  );
}
