import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Banner, EmptyState, Skeleton and Badge (design system §4, §2.1). Status colour appears as an icon
 * and text on a `*-subtle` background, only in inline banners and badges; never as a filled panel.
 */
export type Tone = "info" | "success" | "warning" | "error";

const toneClasses: Record<Tone, string> = {
  info: "bg-subtle text-primary",
  success: "bg-success-subtle text-primary",
  warning: "bg-warning-subtle text-primary",
  error: "bg-error-subtle text-primary",
};
const toneIcon: Record<Tone, ReactNode> = {
  info: <Info className="size-icon shrink-0 text-secondary" strokeWidth={1.5} aria-hidden="true" />,
  success: <CircleCheck className="size-icon shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />,
  warning: <TriangleAlert className="size-icon shrink-0 text-warning" strokeWidth={1.5} aria-hidden="true" />,
  error: <CircleAlert className="size-icon shrink-0 text-error" strokeWidth={1.5} aria-hidden="true" />,
};

/** An inline status line. Errors show the title and the fix together (§3.3). */
export function Banner({ tone = "info", title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex gap-4 rounded-md px-6 py-5 ${toneClasses[tone]}`}
    >
      {toneIcon[tone]}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-body font-medium">{title}</p>
        {children ? <div className="text-body text-secondary">{children}</div> : null}
      </div>
    </div>
  );
}

/** One sentence on what goes here and at most one primary action. No illustration (§3.3). */
export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-5 px-8 py-11 text-center">
      <div className="flex flex-col gap-2">
        <p className="text-title text-primary">{title}</p>
        {detail ? <p className="text-body text-secondary">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A static placeholder for content that is loading; no shimmer (no looping animation, §2.6). */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-xs bg-muted ${className}`} />;
}

export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const color = tone === undefined || tone === "info" ? "bg-muted text-secondary" : toneClasses[tone];
  return (
    <span className={`inline-flex h-tile-sm items-center gap-2 rounded-full px-4 text-micro ${color}`}>{children}</span>
  );
}
