import { Hand } from "lucide-react";
import type { ReactNode } from "react";
import { Banner } from "../components/Feedback";

/** The bot handed the conversation to a person (§9.4): it stays silent and records messages. */
export function HandoffBanner({ reason, action }: { reason?: string | undefined; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-4 rounded-md bg-subtle px-6 py-5">
      <Hand className="size-icon shrink-0 text-secondary" strokeWidth={1.5} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-medium text-primary">Handed off to a person</p>
        <p className="text-body text-secondary" dir="auto">
          {reason ? `${reason}. ` : ""}The bot stays silent until the conversation is released.
        </p>
      </div>
      {action}
    </div>
  );
}

/** An error in a transcript (§5.3): what happened, how to fix it, and where to look. */
export function TranscriptError({ title, fix, action }: { title: string; fix: string; action?: ReactNode }) {
  return (
    <Banner tone="error" title={title}>
      <span className="flex flex-col items-start gap-3">
        <span>{fix}</span>
        {action}
      </span>
    </Banner>
  );
}

/** Under a bot turn: who answered and how long it took. */
export function TurnFooter({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 self-start ps-2 text-micro text-tertiary">{children}</p>;
}
