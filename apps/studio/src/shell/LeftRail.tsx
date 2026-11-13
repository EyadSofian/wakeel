import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  Braces,
  FlaskConical,
  GitCommitHorizontal,
  type LucideIcon,
  MessagesSquare,
  Settings,
  Table2,
  Workflow,
} from "lucide-react";

/** Left rail destinations (design system §5.1), in order; Settings sits at the bottom. */
const DESTINATIONS: { label: string; icon: LucideIcon }[] = [
  { label: "Workflows", icon: Workflow },
  { label: "Knowledge", icon: BookOpen },
  { label: "Tables", icon: Table2 },
  { label: "Variables", icon: Braces },
  { label: "Versions", icon: GitCommitHorizontal },
  { label: "Evals", icon: FlaskConical },
  { label: "Conversations", icon: MessagesSquare },
];

function RailButton({ label, icon: Icon, active = false }: { label: string; icon: LucideIcon; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={railClasses(active)}
    >
      <Icon className="size-icon-lg" strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

const railClasses = (active: boolean) =>
  [
    "flex size-control-lg items-center justify-center rounded-sm transition-colors",
    active ? "bg-accent-subtle text-accent" : "text-secondary hover:bg-subtle hover:text-primary",
  ].join(" ");

/**
 * `active` is the destination the current screen belongs to; screens outside them (the gallery) pass
 * none. With a workspace, Settings links to its settings; the bot destinations arrive with bots (2.x).
 */
export function LeftRail({ active, workspaceId }: { active?: string; workspaceId?: string }) {
  return (
    <nav
      aria-label="Studio"
      className="flex w-rail shrink-0 flex-col items-center gap-2 border-e border-hairline bg-surface py-4"
    >
      {DESTINATIONS.map((d) => (
        <RailButton key={d.label} label={d.label} icon={d.icon} active={d.label === active} />
      ))}
      <div className="mt-auto">
        {workspaceId === undefined ? (
          <RailButton label="Settings" icon={Settings} active={active === "Settings"} />
        ) : (
          <Link
            to="/w/$workspaceId/settings/general"
            params={{ workspaceId }}
            aria-label="Settings"
            title="Settings"
            aria-current={active === "Settings" ? "page" : undefined}
            className={railClasses(active === "Settings")}
          >
            <Settings className="size-icon-lg" strokeWidth={1.5} aria-hidden="true" />
          </Link>
        )}
      </div>
    </nav>
  );
}
