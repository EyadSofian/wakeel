import type { ReactNode } from "react";
import { LeftRail } from "./LeftRail";
import { TopBar } from "./TopBar";

/**
 * The Studio frame (design system §5.1): a 48 px left rail, a 44 px top bar, and the screen. Panels
 * are docked and separated by hairlines, not shadows (§1.2).
 */
export function AppShell({
  title,
  actions,
  active,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  /** Left rail destination this screen belongs to. */
  active?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh bg-canvas text-primary">
      <LeftRail {...(active === undefined ? {} : { active })} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} actions={actions} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
