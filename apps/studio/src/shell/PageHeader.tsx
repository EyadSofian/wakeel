import type { ReactNode } from "react";

/**
 * A screen's content column and header (ADR-017): content is capped at the page width and centred,
 * the header carries the title, one line of context and the view's primary action.
 */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-page flex-col gap-8 px-9 pb-11 pt-9">{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-8">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-heading text-primary">{title}</h1>
        {description ? <p className="text-body text-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-4">{actions}</div> : null}
    </div>
  );
}
