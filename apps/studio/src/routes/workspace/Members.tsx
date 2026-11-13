import { type MemberResponse, WORKSPACE_ROLES, type WorkspaceRole } from "@wakeel/contracts";
import { Button, Dialog, Field, Input, Select, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import {
  useChangeRole,
  useInvitations,
  useInvite,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useSession,
  useWorkspace,
} from "../../api/queries";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { ROLE_LABELS, SettingsLayout } from "./SettingsLayout";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** Settings → Members (design system §5.13): table, invite, role select. */
export function Members({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const session = useSession();
  const can = (p: string) => workspace.data?.permissions.includes(p) ?? false;
  const members = useMembers(workspaceId);
  const invitations = useInvitations(workspaceId, can("member.invite"));
  const changeRole = useChangeRole(workspaceId);
  const revoke = useRevokeInvitation(workspaceId);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<MemberResponse | undefined>();
  const workspaceName = workspace.data?.name ?? "";

  return (
    <SettingsLayout
      workspaceId={workspaceId}
      tab="members"
      actions={
        can("member.invite") ? (
          <Button
            variant="primary"
            icon={<UserPlus className="size-icon" strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => setInviteOpen(true)}
          >
            Invite member
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-9">
        {changeRole.isError ? (
          <div>
            <ProblemBanner error={changeRole.error} />
          </div>
        ) : null}
        {members.isError ? (
          <div>
            <ProblemBanner error={members.error} />
          </div>
        ) : (
          <Table label="Members">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Joined</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody>
              {members.isPending
                ? [0, 1, 2].map((i) => (
                    <Tr key={i} aria-hidden="true">
                      {[0, 1, 2, 3, 4].map((c) => (
                        <Td key={c}>
                          <Skeleton className="h-3 w-12" />
                        </Td>
                      ))}
                    </Tr>
                  ))
                : (members.data ?? []).map((m) => (
                    <Tr key={m.id}>
                      <Td className="max-w-node">
                        <span dir="auto" className="block truncate font-medium text-primary">
                          {m.name}
                        </span>
                      </Td>
                      <Td className="text-secondary">
                        <span dir="ltr">{m.email}</span>
                      </Td>
                      <Td>
                        {can("member.update_role") ? (
                          <Select
                            aria-label={`Role of ${m.name}`}
                            className="w-resource-panel"
                            value={m.role}
                            disabled={changeRole.isPending}
                            onChange={(e) =>
                              changeRole.mutate({ memberId: m.id, role: e.target.value as WorkspaceRole })
                            }
                          >
                            {WORKSPACE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="text-secondary">{ROLE_LABELS[m.role]}</span>
                        )}
                      </Td>
                      <Td className="text-secondary">{dateFormat.format(new Date(m.createdAt))}</Td>
                      <Td className="text-end">
                        {can("member.remove") && m.userId !== session.data?.user.id ? (
                          <Button variant="ghost" size="compact" onClick={() => setRemoving(m)}>
                            Remove
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
            </tbody>
          </Table>
        )}

        {can("member.invite") ? (
          <section aria-labelledby="pending-title" className="flex flex-col gap-4">
            <h2 id="pending-title" className="text-title text-primary">
              Pending invitations
            </h2>
            {invitations.isError ? (
              <div>
                <ProblemBanner error={invitations.error} />
              </div>
            ) : invitations.data && invitations.data.length === 0 ? (
              <p className="text-body text-secondary">No invitations are waiting.</p>
            ) : (
              <Table label="Pending invitations">
                <THead>
                  <tr>
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Expires</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </THead>
                <tbody>
                  {(invitations.data ?? []).map((i) => (
                    <Tr key={i.id}>
                      <Td>
                        <span dir="ltr">{i.email}</span>
                      </Td>
                      <Td className="text-secondary">{ROLE_LABELS[i.role]}</Td>
                      <Td className="text-secondary">{dateFormat.format(new Date(i.expiresAt))}</Td>
                      <Td className="text-end">
                        <Button
                          variant="ghost"
                          size="compact"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(i.id)}
                        >
                          Revoke
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        ) : null}
      </div>

      <InviteDialog workspaceId={workspaceId} open={inviteOpen} onOpenChange={setInviteOpen} />
      <RemoveDialog
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        member={removing}
        onClose={() => setRemoving(undefined)}
      />
    </SettingsLayout>
  );
}

function InviteDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const invite = useInvite(workspaceId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("builder");
  const errors = fieldErrors(invite.error);
  const link = invite.data?.acceptUrl;

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      invite.reset();
      setEmail("");
      setRole("builder");
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate({ email, role });
  };

  if (link !== undefined) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Share the invitation link"
        description="No email is sent yet. The link works once, for this address, and expires in 7 days."
        footer={
          <Button variant="primary" size="large" onClick={() => close(false)}>
            Done
          </Button>
        }
      >
        <Field label="Invitation link">
          {(p) => (
            <Input
              {...p}
              readOnly
              dir="ltr"
              className="font-mono"
              value={link}
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
      title="Invite member"
      footer={
        <>
          <Button size="large" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" variant="primary" size="large" disabled={invite.isPending}>
            Invite member
          </Button>
        </>
      }
    >
      <form id="invite-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {invite.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={invite.error} /> : null}
        <Field label="Email" error={errors["email"]}>
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field
          label="Role"
          help="Admins manage members, keys and settings. Builders build and publish bots. Viewers only read."
        >
          {(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
              {WORKSPACE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  workspaceId,
  workspaceName,
  member,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  member: MemberResponse | undefined;
  onClose: () => void;
}) {
  const remove = useRemoveMember(workspaceId);
  return (
    <Dialog
      open={member !== undefined}
      onOpenChange={(o) => {
        if (!o) {
          remove.reset();
          onClose();
        }
      }}
      title={`Remove ${member?.name ?? ""} from ${workspaceName}?`}
      description="They lose access to every bot in this workspace at once. You can invite them again later."
      footer={
        <>
          <Button size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="large"
            disabled={remove.isPending}
            onClick={() => member && remove.mutate(member.id, { onSuccess: onClose })}
          >
            Remove member
          </Button>
        </>
      }
    >
      {remove.isError ? <ProblemBanner error={remove.error} /> : <span className="sr-only">Confirm removal</span>}
    </Dialog>
  );
}
