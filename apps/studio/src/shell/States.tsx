import { Link } from "@tanstack/react-router";
import { ERRORS, fill } from "@wakeel/contracts";
import { Button, buttonClasses } from "@wakeel/ui";
import { AppShell } from "./AppShell";

/**
 * Router-level states (design system §3.3): one sentence on what happened, one action. Error text
 * comes from errors.ts; nothing here invents an error sentence.
 */
function StateBody({ title, detail, action }: { title: string; detail?: string; action: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 py-12 text-center">
      <div className="flex max-w-inspector-max flex-col gap-2">
        <h1 className="text-title text-primary">{title}</h1>
        {detail ? <p className="text-body text-secondary">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function NotFoundState() {
  const error = ERRORS.not_found;
  return (
    <AppShell title="Not found">
      <StateBody
        title={error.title}
        detail={error.fix}
        action={
          <Link to="/__gallery" className={buttonClasses("primary")}>
            Open gallery
          </Link>
        }
      />
    </AppShell>
  );
}

export function ErrorState({ requestId }: { requestId?: string }) {
  const error = ERRORS.internal_error;
  // The fix names a request id for support. Failures in the browser have none, so they show only the
  // title and the action that fixes them.
  const detail = requestId === undefined ? undefined : fill(error.fix, { requestId });
  return (
    <AppShell title="Error">
      <StateBody
        title={error.title}
        detail={detail}
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        }
      />
    </AppShell>
  );
}
