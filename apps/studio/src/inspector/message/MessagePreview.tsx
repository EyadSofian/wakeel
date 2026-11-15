import type { MessageTemplate } from "@wakeel/contracts";
import { splitTemplate } from "@wakeel/ui";
import { ChevronDown, FileText, ImageIcon, MapPin, Puzzle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The live preview bubble of a message (design system §4 MessageEditor), as the emulator will draw
 * it, with `{{ … }}` placeholders shown as chips isolated in `<bdi>` so they never reorder Arabic
 * text (§6). Nothing here loads a builder-supplied URL: images and files are shown as frames.
 */
function Text({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span dir="auto" className={`whitespace-pre-wrap break-words ${className}`}>
      {splitTemplate(value).map((s, i) =>
        s.placeholder ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity besides order.
          <bdi key={i} className="rounded-xs bg-accent-subtle px-1 font-mono text-code-small text-accent-text">
            {s.text.slice(2, -2).trim()}
          </bdi>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity besides order.
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full self-start rounded-lg rounded-ss-xs border border-hairline bg-surface px-6 py-4 text-content text-primary">
      {children}
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-control-sm max-w-full items-center truncate rounded-full border border-accent px-5 text-small font-medium text-accent-text">
      {children}
    </span>
  );
}

function CardBody({
  body,
}: {
  body: { title: string; subtitle?: string | undefined; imageUrl?: string | undefined; actions: { label: string }[] };
}) {
  return (
    <div className="flex w-node shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
      {body.imageUrl ? (
        <div className="flex h-12 items-center justify-center bg-muted text-tertiary">
          <ImageIcon className="size-icon-lg" strokeWidth={1.75} aria-label="Image" />
        </div>
      ) : null}
      <div className="flex flex-col gap-1 px-6 py-4">
        <Text value={body.title} className="text-body font-semibold text-primary" />
        {body.subtitle ? <Text value={body.subtitle} className="text-small text-secondary" /> : null}
      </div>
      {body.actions.length > 0 ? (
        <div className="flex flex-col border-t border-hairline">
          {body.actions.map((a, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: preview of a list the builder edits by position.
              key={i}
              className="border-b border-hairline px-6 py-3 text-center text-small font-medium text-accent-text last:border-b-0"
            >
              <Text value={a.label} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MessagePreview({ message }: { message: MessageTemplate }) {
  return (
    <figure aria-label="Message preview" className="flex flex-col gap-3 rounded-lg bg-canvas p-5">
      <figcaption className="text-small text-tertiary">Preview</figcaption>
      <Body message={message} />
    </figure>
  );
}

function Body({ message: m }: { message: MessageTemplate }) {
  switch (m.type) {
    case "text":
      return (
        <Bubble>
          <Text value={m.text} />
        </Bubble>
      );
    case "choice":
      return (
        <div className="flex flex-col gap-3">
          <Bubble>
            <Text value={m.text} />
          </Bubble>
          <div className="flex flex-wrap gap-2">
            {m.options.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: preview of a list the builder edits by position.
              <Pill key={i}>
                <Text value={o.label} />
              </Pill>
            ))}
          </div>
        </div>
      );
    case "dropdown":
      return (
        <div className="flex flex-col gap-3">
          <Bubble>
            <Text value={m.text} />
          </Bubble>
          <span className="flex h-control items-center justify-between rounded-sm border border-hairline bg-surface px-5 text-body text-tertiary">
            <Text value={m.placeholder || "Choose an option"} />
            <ChevronDown className="size-icon" strokeWidth={1.75} aria-hidden="true" />
          </span>
        </div>
      );
    case "image":
      return (
        <div className="flex w-node flex-col gap-2">
          <div className="flex h-12 items-center justify-center rounded-lg border border-hairline bg-muted text-tertiary">
            <ImageIcon className="size-icon-lg" strokeWidth={1.75} aria-label={m.alt || "Image"} />
          </div>
          {m.caption ? <Text value={m.caption} className="text-small text-secondary" /> : null}
        </div>
      );
    case "file":
      return (
        <span className="flex items-center gap-4 self-start rounded-lg border border-hairline bg-surface px-5 py-4">
          <FileText className="size-icon-lg text-secondary" strokeWidth={1.75} aria-hidden="true" />
          <Text value={m.name} className="text-body text-primary" />
        </span>
      );
    case "location":
      return (
        <div className="flex w-node flex-col gap-1 rounded-lg border border-hairline bg-surface px-6 py-4">
          <span className="flex items-center gap-3 text-body font-semibold text-primary">
            <MapPin className="size-icon text-secondary" strokeWidth={1.75} aria-hidden="true" />
            <Text value={m.title || "Location"} />
          </span>
          {m.address ? <Text value={m.address} className="text-small text-secondary" /> : null}
          <span dir="ltr" className="font-mono text-code-small text-tertiary">
            {m.latitude}, {m.longitude}
          </span>
        </div>
      );
    case "card":
      return <CardBody body={m} />;
    case "carousel":
      return (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {m.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview of a list the builder edits by position.
            <CardBody key={i} body={item} />
          ))}
        </div>
      );
    case "custom":
      return (
        <span className="flex items-center gap-4 self-start rounded-lg border border-dashed border-strong px-5 py-4 text-small text-secondary">
          <Puzzle className="size-icon" strokeWidth={1.75} aria-hidden="true" />
          Custom message <span className="font-mono text-primary">{m.name}</span>, sent to your bridge as data
        </span>
      );
  }
}
