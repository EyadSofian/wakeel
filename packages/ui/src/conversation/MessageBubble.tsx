import type { BotMessagePayload, Citation, Option, UserMessagePayload } from "@wakeel/contracts";
import { ExternalLink, FileText, MapPin, MousePointerClick } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../components/Button";
import { Select } from "../components/Field";
import { Markdown } from "./Markdown";
import { QuickReplies } from "./QuickReplies";

/** What a builder did with an interactive message: picked an option, or a card's "say" action. */
export type BubbleAction = { type: "postback"; value: string; label: string } | { type: "say"; text: string };

export interface MessageBubbleProps {
  direction: "in" | "out";
  payload: BotMessagePayload | UserMessagePayload;
  citations?: readonly Citation[];
  /** Interactive parts (buttons, dropdowns, card actions) call this; absent or `disabled` = read-only. */
  onAction?: (action: BubbleAction) => void;
  /** Buttons of an earlier turn stay visible but cannot be used again. */
  disabled?: boolean;
}

/**
 * One message in a transcript (design system §4 Conversation, §5.3). The user's bubbles sit on the
 * end side, the bot's on the start side; text inside follows its own first strong character
 * (`dir="auto"`, §7), so Arabic in an English Studio still reads right to left.
 */
export function MessageBubble({ direction, payload, citations = [], onAction, disabled }: MessageBubbleProps) {
  const user = direction === "in";
  const act = disabled ? undefined : onAction;
  return (
    <div className={`flex w-full flex-col gap-3 ${user ? "items-end" : "items-start"}`}>
      <Body payload={payload} user={user} onAction={act} disabled={disabled === true} />
      {citations.length > 0 ? <Citations citations={citations} /> : null}
    </div>
  );
}

function Bubble({ user, children }: { user: boolean; children: ReactNode }) {
  return (
    <div
      dir="auto"
      className={`max-w-4/5 rounded-lg px-5 py-4 text-content ${
        user ? "bg-accent-subtle text-primary" : "border border-hairline bg-surface text-primary"
      }`}
    >
      {children}
    </div>
  );
}

function Body({
  payload,
  user,
  onAction,
  disabled,
}: {
  payload: BotMessagePayload | UserMessagePayload;
  user: boolean;
  onAction: ((a: BubbleAction) => void) | undefined;
  disabled: boolean;
}) {
  const pick = (o: Option) => onAction?.({ type: "postback", value: o.value, label: o.label });
  switch (payload.type) {
    case "text":
      return (
        <Bubble user={user}>
          {payload.format === "plain" ? <PlainText text={payload.text} /> : <Markdown text={payload.text} />}
        </Bubble>
      );
    case "postback":
      return (
        <Bubble user={user}>
          <span className="inline-flex items-center gap-2">
            <MousePointerClick className="size-icon-sm shrink-0 text-secondary" strokeWidth={1.75} aria-hidden="true" />
            <span dir="auto">{payload.label ?? payload.value}</span>
          </span>
        </Bubble>
      );
    case "image":
      return (
        <figure className="flex max-w-4/5 flex-col gap-2">
          <img
            src={payload.url}
            alt={payload.alt ?? ""}
            loading="lazy"
            className="max-h-picker-height w-full rounded-lg border border-hairline bg-subtle object-cover"
          />
          {payload.caption ? (
            <figcaption dir="auto" className="text-small text-secondary">
              {payload.caption}
            </figcaption>
          ) : null}
        </figure>
      );
    case "file":
      return (
        <Bubble user={user}>
          <a
            href={payload.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="flex items-center gap-4 text-primary hover:text-accent-text"
          >
            <FileText className="size-icon-lg shrink-0 text-secondary" strokeWidth={1.5} aria-hidden="true" />
            <span className="flex min-w-0 flex-col">
              <span dir="auto" className="truncate font-medium">
                {payload.name}
              </span>
              {payload.sizeBytes !== undefined || payload.mime ? (
                <span className="text-small text-secondary">
                  {[payload.mime, payload.sizeBytes !== undefined ? formatBytes(payload.sizeBytes) : undefined]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </span>
          </a>
        </Bubble>
      );
    case "location":
      return (
        <Bubble user={user}>
          <span className="flex items-start gap-4">
            <MapPin className="size-icon-lg shrink-0 text-secondary" strokeWidth={1.5} aria-hidden="true" />
            <span className="flex min-w-0 flex-col">
              <span dir="auto" className="font-medium">
                {payload.title ?? "Location"}
              </span>
              {payload.address ? (
                <span dir="auto" className="text-small text-secondary">
                  {payload.address}
                </span>
              ) : null}
              <span className="font-mono text-code-small text-tertiary" dir="ltr">
                {payload.latitude.toFixed(5)}, {payload.longitude.toFixed(5)}
              </span>
            </span>
          </span>
        </Bubble>
      );
    case "choice":
      return (
        <>
          <Bubble user={user}>
            <Markdown text={payload.text} />
          </Bubble>
          <QuickReplies options={payload.options} onPick={onAction ? pick : undefined} disabled={disabled} />
        </>
      );
    case "dropdown":
      return (
        <>
          <Bubble user={user}>
            <Markdown text={payload.text} />
          </Bubble>
          <Dropdown options={payload.options} placeholder={payload.placeholder} onPick={onAction ? pick : undefined} />
        </>
      );
    case "card":
      return <CardView card={payload} onAction={onAction} />;
    case "carousel":
      return (
        <ul aria-label="Carousel" className="flex w-full snap-x gap-4 overflow-x-auto pb-2">
          {payload.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: carousel items are positional.
            <li key={i} className="w-node shrink-0 snap-start">
              <CardView card={item} onAction={onAction} />
            </li>
          ))}
        </ul>
      );
    case "custom":
      return (
        <Bubble user={user}>
          <span className="flex flex-col gap-2">
            <span className="text-small text-secondary">
              Custom message <span className="font-mono text-code-small text-primary">{payload.name}</span>
            </span>
            <pre dir="ltr" className="overflow-x-auto rounded-sm bg-subtle p-3 font-mono text-code-small">
              {JSON.stringify(payload.data, null, 2)}
            </pre>
          </span>
        </Bubble>
      );
  }
}

/** URLs in plain text are isolated as left-to-right runs, as in markdown, but stay plain text. */
const URL_IN_TEXT = /(https?:\/\/[^\s<>]+)/;

function PlainText({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words">
      {text.split(URL_IN_TEXT).map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: split parts are positional.
          <span key={i} dir="ltr" className="break-words">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function Dropdown({
  options,
  placeholder,
  onPick,
}: {
  options: readonly Option[];
  placeholder: string | undefined;
  onPick: ((o: Option) => void) | undefined;
}) {
  const [value, setValue] = useState("");
  const chosen = options.find((o) => o.value === value);
  return (
    <div className="flex max-w-4/5 items-center gap-3">
      <Select
        aria-label={placeholder ?? "Choose an option"}
        value={value}
        disabled={!onPick}
        onChange={(e) => setValue(e.target.value)}
      >
        <option value="" disabled>
          {placeholder ?? "Choose an option"}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value} dir="auto">
            {o.label}
          </option>
        ))}
      </Select>
      <Button size="compact" disabled={!onPick || !chosen} onClick={() => chosen && onPick?.(chosen)}>
        Send
      </Button>
    </div>
  );
}

type CardData = {
  title: string;
  subtitle?: string | undefined;
  imageUrl?: string | undefined;
  actions: readonly { type: "postback" | "url" | "say"; label: string; value: string }[];
};

function CardView({ card, onAction }: { card: CardData; onAction: ((a: BubbleAction) => void) | undefined }) {
  return (
    <article className="flex w-node max-w-full flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
      {card.imageUrl ? (
        <img src={card.imageUrl} alt="" loading="lazy" className="h-tile-lg w-full bg-subtle object-cover" />
      ) : null}
      <div className="flex flex-col gap-1 px-5 py-4">
        <h3 dir="auto" className="text-body font-medium text-primary">
          {card.title}
        </h3>
        {card.subtitle ? (
          <p dir="auto" className="text-small text-secondary">
            {card.subtitle}
          </p>
        ) : null}
      </div>
      {card.actions.length > 0 ? (
        <div className="flex flex-col divide-y divide-hairline border-t border-hairline">
          {card.actions.map((a) =>
            a.type === "url" ? (
              <a
                key={`${a.type}:${a.value}`}
                href={a.value}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="flex h-control items-center justify-center gap-2 text-body text-accent-text hover:bg-subtle"
              >
                <span dir="auto">{a.label}</span>
                <ExternalLink className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
              </a>
            ) : (
              <button
                key={`${a.type}:${a.value}`}
                type="button"
                disabled={!onAction}
                onClick={() =>
                  onAction?.(
                    a.type === "say"
                      ? { type: "say", text: a.value }
                      : { type: "postback", value: a.value, label: a.label },
                  )
                }
                className="flex h-control items-center justify-center text-body text-accent-text hover:bg-subtle disabled:text-tertiary disabled:hover:bg-transparent"
              >
                <span dir="auto">{a.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </article>
  );
}

function Citations({ citations }: { citations: readonly Citation[] }) {
  return (
    <ol aria-label="Sources" className="flex max-w-4/5 flex-wrap gap-2">
      {citations.map((c) => (
        <li key={c.index}>
          <span
            title={c.title}
            className="inline-flex h-tile-sm items-center gap-2 rounded-full border border-hairline bg-surface px-3 text-micro text-secondary"
          >
            <span className="tabular-nums text-primary">{c.index}</span>
            <span dir="auto" className="max-w-tile-lg truncate">
              {c.title}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
