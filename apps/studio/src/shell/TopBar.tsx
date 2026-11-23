import { Link } from "@tanstack/react-router";
import { BRAND } from "@wakeel/config/brand";
import { Brand } from "@wakeel/ui";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Top bar (design system §5.1, ADR-017): the brand over the rail, a hairline, the breadcrumb, and
 * the screen's actions on the end side.
 */
export function TopBar({
  title,
  actions,
  workspaceId,
}: {
  title: ReactNode;
  actions?: ReactNode;
  workspaceId?: string;
}) {
  return (
    <header className="flex h-topbar shrink-0 items-center gap-6 wk-glass-bar border-b border-hairline pe-6 ps-5">
      {workspaceId === undefined ? (
        <Brand name={BRAND.name} markSrc={BRAND.logo.mark} />
      ) : (
        <Link to="/w/$workspaceId" params={{ workspaceId }} aria-label={`${BRAND.name} home`} className="rounded-sm">
          <Brand name={BRAND.name} markSrc={BRAND.logo.mark} />
        </Link>
      )}
      <span aria-hidden="true" className="h-control-sm border-s border-hairline" />
      <div className="min-w-0 flex-1 truncate text-body font-medium text-primary">{title}</div>
      <ThemeToggle />
      {actions ? <div className="flex items-center gap-4">{actions}</div> : null}
    </header>
  );
}
