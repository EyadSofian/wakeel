import type { ReactNode } from "react";

/** Top bar (design system §5.1): breadcrumb on the start side, actions on the end side, 44 px high. */
export function TopBar({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex h-topbar shrink-0 items-center gap-5 border-b border-hairline bg-surface px-5">
      <div className="min-w-0 flex-1 truncate text-body font-medium text-primary">{title}</div>
      {actions ? <div className="flex items-center gap-4">{actions}</div> : null}
    </header>
  );
}
