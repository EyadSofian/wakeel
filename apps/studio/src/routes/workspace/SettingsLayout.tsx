import { Link } from "@tanstack/react-router";
import { tabClasses } from "@wakeel/ui";
import type { ReactNode } from "react";
import { AppShell } from "../../shell/AppShell";
import { WorkspaceSwitcher } from "../../shell/WorkspaceSwitcher";

export type SettingsTab = "general" | "members" | "api-keys";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "api-keys", label: "API keys" },
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
    <AppShell
      title={<WorkspaceSwitcher workspaceId={workspaceId} />}
      active="Settings"
      workspaceId={workspaceId}
      actions={actions}
    >
      <div className="flex flex-col">
        <div className="flex flex-col gap-2 border-b border-hairline px-5 pt-6">
          <h1 className="text-heading text-primary">Settings</h1>
          <nav aria-label="Settings" className="flex gap-6">
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
      </div>
    </AppShell>
  );
}

export const ROLE_LABELS = { owner: "Owner", admin: "Admin", builder: "Builder", viewer: "Viewer" } as const;
