import { Link } from "@tanstack/react-router";
import { tabClasses } from "@wakeel/ui";
import type { ReactNode } from "react";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { WorkspaceSwitcher } from "../../shell/WorkspaceSwitcher";

export type SettingsTab = "general" | "members" | "api-keys" | "models";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "api-keys", label: "API keys" },
  { id: "models", label: "Models" },
];

/**
 * Workspace settings (design system §5.13). The tabs for Models, Usage and Audit log arrive with
 * their phases. Tabs are links, so each has its own address and the browser's back button works.
 */
export function SettingsLayout({
  workspaceId,
  tab,
  actions,
  children,
}: {
  workspaceId: string;
  tab: SettingsTab;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell title={<WorkspaceSwitcher workspaceId={workspaceId} />} active="Settings" workspaceId={workspaceId}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title="Settings"
            description="The workspace's name, who can work in it, the keys that call its API, and the models its bots use."
            actions={actions}
          />
          <nav aria-label="Settings" className="flex gap-7 border-b border-hairline">
            {TABS.map((t) => (
              <Link
                key={t.id}
                to={`/w/$workspaceId/settings/${t.id}`}
                params={{ workspaceId }}
                aria-current={t.id === tab ? "page" : undefined}
                className={tabClasses(t.id === tab)}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        {children}
      </Page>
    </AppShell>
  );
}

export const ROLE_LABELS = { owner: "Owner", admin: "Admin", builder: "Builder", viewer: "Viewer" } as const;
