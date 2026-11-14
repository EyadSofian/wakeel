import {
  Button,
  Composer,
  EmptyState,
  HandoffBanner,
  MessageBubble,
  TranscriptError,
  type TranscriptItem,
  TranscriptList,
  TurnFooter,
  TypingIndicator,
  tabClasses,
} from "@wakeel/ui";
import { ChevronDown, Play, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useCanvas } from "../canvas/context";
import { useEmulator } from "./controller";
import type { TranscriptEntry } from "./model";
import { TestUserForm } from "./TestUserForm";
import { VariablesTab } from "./VariablesTab";

/**
 * The emulator panel (design system §5.3, task 4.6): it shares the end side with the inspector,
 * talks to the draft as the test user, and shows the turn as it streams. Test conversations run on
 * the builder's own draft connection and are never billed.
 */
export function EmulatorPanel({ onShowInspector }: { onShowInspector: () => void }) {
  const transcript = useEmulator((s) => s.transcript);
  const user = useEmulator((s) => s.user);
  const startedAt = useEmulator((s) => s.startedAt);
  const send = useEmulator((s) => s.send);
  const postback = useEmulator((s) => s.postback);
  const reset = useEmulator((s) => s.reset);
  const botName = useCanvas((s) => s.manifest?.doc.name ?? "Bot");
  const [editingUser, setEditingUser] = useState(false);

  const items = useMemo<TranscriptItem[]>(
    () =>
      transcript.items.map((entry) => ({
        key: entry.key,
        side: entry.kind === "message" ? (entry.direction === "in" ? "user" : "bot") : "system",
        node: (
          <Entry
            entry={entry}
            botName={botName}
            onAction={(a) => void (a.type === "say" ? send(a.text) : postback(a.value, a.label))}
            onReset={reset}
          />
        ),
      })),
    [transcript.items, botName, send, postback, reset],
  );

  return (
    <aside
      aria-label="Emulator"
      className="flex w-emulator shrink-0 flex-col overflow-hidden border-s border-hairline bg-surface"
    >
      <header className="flex items-center gap-4 border-b border-hairline px-6">
        <div role="tablist" aria-label="Side panel" className="flex flex-1 gap-6">
          <button
            type="button"
            role="tab"
            aria-selected={false}
            className={tabClasses(false)}
            onClick={onShowInspector}
          >
            Inspector
          </button>
          <button type="button" role="tab" aria-selected className={tabClasses(true)}>
            Emulator
          </button>
        </div>
        <button
          type="button"
          aria-label="Reset the conversation"
          title="Reset"
          onClick={reset}
          className="flex size-control-sm items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
        >
          <RotateCcw className="size-icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="flex items-center gap-2 border-b border-hairline px-6 py-3 text-small text-secondary">
        <span>Testing draft · as</span>
        <button
          type="button"
          aria-expanded={editingUser}
          onClick={() => setEditingUser((v) => !v)}
          className="inline-flex min-w-0 items-center gap-1 rounded-xs font-medium text-primary hover:text-accent-text"
        >
          <span dir="auto" className="truncate">
            {user.name ?? "Test user"}
          </span>
          <ChevronDown className="size-icon-sm shrink-0" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {editingUser ? <TestUserForm onDone={() => setEditingUser(false)} /> : null}
      {startedAt ? (
        <p className="flex items-center gap-2 border-b border-hairline px-6 py-2 text-small text-secondary">
          <Play className="size-icon-sm shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 truncate">
            Started at{" "}
            <span dir="auto" className="font-medium text-primary">
              {startedAt}
            </span>
          </span>
        </p>
      ) : null}
      <TranscriptList
        label="Test conversation"
        items={items}
        footer={transcript.running && !answered(transcript.items) ? <TypingIndicator /> : null}
        empty={
          <EmptyState
            title="Send a message to test the draft"
            detail="You talk to the latest draft as the test user. Test conversations are never billed."
          />
        }
      />
      <VariablesTab />
      <Composer onSend={(text) => void send(text)} placeholder="Message…" label="Message the bot" />
    </aside>
  );
}

/** Whether anything has come back since the builder's last message; until then the dots show. */
function answered(items: readonly TranscriptEntry[]): boolean {
  const last = items.at(-1);
  return last !== undefined && !(last.kind === "message" && last.direction === "in");
}

function Entry({
  entry,
  botName,
  onAction,
  onReset,
}: {
  entry: TranscriptEntry;
  botName: string;
  onAction: Parameters<typeof MessageBubble>[0]["onAction"];
  onReset: () => void;
}) {
  switch (entry.kind) {
    case "message":
      return (
        <MessageBubble
          direction={entry.direction}
          payload={entry.payload}
          citations={entry.citations}
          onAction={onAction}
          disabled={!entry.live}
        />
      );
    case "error":
      return <TranscriptError title={entry.title} fix={entry.fix} />;
    case "problem":
      return <TranscriptError title={entry.title} fix={entry.fix} />;
    case "handoff":
      return <HandoffBanner reason={entry.reason} />;
    case "ended":
      return (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <p className="text-small text-secondary">The conversation ended ({endedLabel(entry.reason)}).</p>
          <Button size="compact" onClick={onReset}>
            Start a new conversation
          </Button>
        </div>
      );
    case "footer":
      return (
        <TurnFooter>
          <span dir="auto">{botName}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{(entry.durationMs / 1000).toFixed(1)} s</span>
          {entry.status === "waiting" ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Waiting for the user</span>
            </>
          ) : null}
        </TurnFooter>
      );
  }
}

const endedLabel = (reason: string) =>
  reason === "inactivity" ? "no reply in time" : reason === "error" ? "after an error" : reason;
