import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  Braces,
  Database,
  FlaskConical,
  GitCommitHorizontal,
  House,
  type LucideIcon,
  MessagesSquare,
  Settings,
  Workflow,
} from "lucide-react";

/** Left rail destinations (design system §5.1), in order; Settings sits at the bottom. */
const DESTINATIONS: { label: string; icon: LucideIcon }[] = [
  { label: "Workflows", icon: Workflow },
  { label: "Knowledge", icon: BookOpen },
  { label: "Tables", icon: Database },
  { label: "Variables", icon: Braces },
  { label: "Versions", icon: GitCommitHorizontal },
  { label: "Evals", icon: FlaskConical },
  { label: "Conversations", icon: MessagesSquare },
];

/** The active destination is a filled accent tile (ADR-017); the rest stay quiet. */
const railClasses = (active: boolean) =>
  [
    "flex size-tile-lg items-center justify-center rounded-md transition-colors",
    active ? "bg-accent text-on-accent" : "text-secondary hover:bg-subtle hover:text-primary",
  ].join(" ");

function RailButton({ label, icon: Icon, active = false }: { label: string; icon: LucideIcon; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={railClasses(active)}
    >
      <Icon className="size-icon-lg" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function RailLink({
  to,
  workspaceId,
  label,
  icon: Icon,
  active,
}: {
  to: "/w/$workspaceId" | "/w/$workspaceId/settings/general";
  workspaceId: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      to={to}
      params={{ workspaceId }}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={railClasses(active)}
    >
      <Icon className="size-icon-lg" strokeWidth={1.75} aria-hidden="true" />
    </Link>
  );
}

/**
 * `active` is the destination the current screen belongs to; screens outside them (the gallery) pass
 * none. With a workspace, Home and Settings are links; the bot destinations arrive with their phases.
 */
export function LeftRail({ active, workspaceId }: { active?: string; workspaceId?: string }) {
  return (
    <nav
      aria-label="Studio"
      className="flex w-rail shrink-0 flex-col items-center gap-3 border-e border-hairline bg-surface py-5"
    >
      {workspaceId === undefined ? (
        <RailButton label="Home" icon={House} active={active === "Home"} />
      ) : (
        <RailLink to="/w/$workspaceId" workspaceId={workspaceId} label="Home" icon={House} active={active === "Home"} />
      )}
      <span aria-hidden="true" className="my-2 w-control-sm border-t border-hairline" />
      {DESTINATIONS.map((d) => (
        <RailButton key={d.label} label={d.label} icon={d.icon} active={d.label === active} />
      ))}
      <div className="mt-auto">
        {workspaceId === undefined ? (
          <RailButton label="Settings" icon={Settings} active={active === "Settings"} />
        ) : (
          <RailLink
            to="/w/$workspaceId/settings/general"
            workspaceId={workspaceId}
            label="Settings"
            icon={Settings}
            active={active === "Settings"}
          />
        )}
      </div>
    </nav>
  );
}
