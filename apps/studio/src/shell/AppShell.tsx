import type { ReactNode } from "react";
import { LeftRail } from "./LeftRail";
import { TopBar } from "./TopBar";

/**
 * The Studio frame (design system §5.1, ADR-017): a full-width top bar with the brand, then the
 * rail, an optional resource panel, the screen and an optional inspector. Docked panels are
 * separated by hairlines, not shadows.
 */
export function AppShell({
  title,
  actions,
  active,
  workspaceId,
  botId,
  panel,
  inspector,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  /** Left rail destination this screen belongs to. */
  active?: string;
  /** The workspace the screen is in, for the rail's links. */
  workspaceId?: string;
  /** The bot the screen is in; its destinations in the rail become links. */
  botId?: string;
  /** Resource panel docked between the rail and the screen (node library, lists). */
  panel?: ReactNode;
  /** Inspector docked on the end side. */
  inspector?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col bg-canvas text-primary">
      <TopBar title={title} actions={actions} {...(workspaceId === undefined ? {} : { workspaceId })} />
      <div className="flex min-h-0 flex-1">
        <LeftRail
          {...(active === undefined ? {} : { active })}
          {...(workspaceId === undefined ? {} : { workspaceId })}
          {...(botId === undefined ? {} : { botId })}
        />
        {panel}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
        {inspector}
      </div>
    </div>
  );
}
