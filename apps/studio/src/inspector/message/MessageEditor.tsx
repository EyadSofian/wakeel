import type { MessageTemplate, Node } from "@wakeel/contracts";
import { Button, SegmentedControl, Select } from "@wakeel/ui";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { StringField } from "../fields";
import { MessagePreview } from "./MessagePreview";

/**
 * MessageEditor (design system §4): one form per message type, with the live preview under it.
 * Every string is a TemplateInput or ExpressionInput bound to its issue path, so the validator's
 * fix sentence appears under the field it is about.
 */
export type MessageType = MessageTemplate["type"];

export const MESSAGE_TYPES: { value: MessageType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "choice", label: "Choices" },
  { value: "dropdown", label: "Dropdown" },
  { value: "image", label: "Image" },
  { value: "file", label: "File" },
  { value: "card", label: "Card" },
  { value: "carousel", label: "Carousel" },
  { value: "location", label: "Location" },
  { value: "custom", label: "Custom" },
];

type Card = Extract<MessageTemplate, { type: "card" }>;
type Body = Omit<Card, "type">;
type Action = Body["actions"][number];

/** The main words of a message, carried over when its type changes. */
function mainText(m: MessageTemplate): string {
  switch (m.type) {
    case "text":
    case "choice":
    case "dropdown":
      return m.text;
    case "card":
      return m.title;
    case "image":
      return m.caption ?? "";
    case "location":
      return m.title ?? "";
    case "carousel":
      return m.items[0]?.title ?? "";
    default:
      return "";
  }
}

/** A schema-valid message of `type`, keeping the current text where it fits. */
export function convertMessage(m: MessageTemplate, type: MessageType): MessageTemplate {
  if (m.type === type) return m;
  const text = mainText(m);
  const options =
    m.type === "choice" || m.type === "dropdown"
      ? m.options
      : [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ];
  switch (type) {
    case "text":
      return { type, text: text || "New message", format: "markdown" };
    case "choice":
      return { type, text: text || "Choose one", options };
    case "dropdown":
      return { type, text: text || "Choose one", options };
    case "image":
      return { type, url: "https://", ...(text ? { caption: text } : {}) };
    case "file":
      return { type, url: "https://", name: "document.pdf" };
    case "card":
      return { type, title: text || "Title", actions: [] };
    case "carousel":
      return { type, items: [{ title: text || "First item", actions: [] }] };
    case "location":
      return { type, latitude: "30.0444", longitude: "31.2357", ...(text ? { title: text } : {}) };
    case "custom":
      return { type, name: "custom", data: "null" };
  }
}

export function MessageEditor({
  message,
  onCommit,
  node,
  path,
  types = MESSAGE_TYPES.map((t) => t.value),
  textLabel = "Text",
}: {
  message: MessageTemplate;
  onCommit: (m: MessageTemplate) => void;
  node: Node;
  /** Issue path of the message: `…cards.<id>.message`. */
  path: string;
  /** Types offered (Ask limits its question to text, choices and dropdown). */
  types?: readonly MessageType[];
  /** Label of the main text field: "Text" for a message, "Question" for Ask. */
  textLabel?: string;
}) {
  const typeId = useId();
  // Drafts of top-level fields as they are typed, so the preview is live before anything commits.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: a committed message replaces the drafts.
  useEffect(() => setDrafts({}), [message]);
  const live = { ...message, ...drafts } as MessageTemplate;
  const offered = MESSAGE_TYPES.filter((t) => types.includes(t.value) || t.value === message.type);
  const set = <K extends string>(patch: Record<K, unknown>) => onCommit({ ...message, ...patch } as MessageTemplate);
  const str = (
    label: string,
    field: string,
    value: string,
    check: "text" | "required" | "expression",
    help?: string,
  ) => (
    <StringField
      key={`${message.type}.${field}`}
      label={label}
      {...(help ? { help } : {})}
      value={value}
      check={check}
      path={`${path}.${field}`}
      node={node}
      onCommit={(v) => set({ [field]: v } as Record<string, unknown>)}
      onDraft={(v) => setDrafts((d) => ({ ...d, [field]: v }))}
      rows={field === "text" ? 3 : 1}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label htmlFor={typeId} className="text-small font-medium text-primary">
          Message type
        </label>
        <Select
          id={typeId}
          value={message.type}
          onChange={(e) => onCommit(convertMessage(message, e.target.value as MessageType))}
        >
          {offered.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>

      {message.type === "text" ? (
        <>
          {str(textLabel, "text", message.text, "required", "Type {{ to insert a variable.")}
          <SegmentedControl
            label="Format"
            value={message.format}
            options={[
              { value: "markdown", label: "Markdown" },
              { value: "plain", label: "Plain text" },
            ]}
            onChange={(format) => set({ format })}
          />
        </>
      ) : null}

      {message.type === "choice" || message.type === "dropdown" ? (
        <>
          {str(textLabel === "Text" ? "Question" : textLabel, "text", message.text, "required")}
          {message.type === "dropdown"
            ? str("Placeholder", "placeholder", message.placeholder ?? "", "text", "Shown before anything is chosen.")
            : null}
          <ListEditor
            label="Options"
            addLabel="Add option"
            items={message.options}
            max={message.type === "choice" ? 20 : 100}
            min={1}
            make={(i) => ({ label: `Option ${i + 1}`, value: `option_${i + 1}` })}
            onChange={(options) => set({ options })}
            render={(o, i) => (
              <>
                <StringField
                  label="Label"
                  value={o.label}
                  check="required"
                  path={`${path}.options[${i}].label`}
                  node={node}
                  rows={1}
                  onCommit={(label) => set({ options: message.options.map((x, j) => (j === i ? { ...x, label } : x)) })}
                />
                <StringField
                  label="Value"
                  help="Saved when this option is chosen."
                  value={o.value}
                  check="required"
                  path={`${path}.options[${i}].value`}
                  node={node}
                  rows={1}
                  onCommit={(value) => set({ options: message.options.map((x, j) => (j === i ? { ...x, value } : x)) })}
                />
              </>
            )}
          />
        </>
      ) : null}

      {message.type === "image" ? (
        <>
          {str("Image address", "url", message.url, "required", "An https address or {{ a variable }}.")}
          {str("Description", "alt", message.alt ?? "", "text", "Read aloud by screen readers.")}
          {str("Caption", "caption", message.caption ?? "", "text")}
        </>
      ) : null}

      {message.type === "file" ? (
        <>
          {str("File address", "url", message.url, "required")}
          {str("File name", "name", message.name, "required")}
        </>
      ) : null}

      {message.type === "location" ? (
        <>
          {str("Latitude", "latitude", message.latitude, "expression")}
          {str("Longitude", "longitude", message.longitude, "expression")}
          {str("Title", "title", message.title ?? "", "text")}
          {str("Address", "address", message.address ?? "", "text")}
        </>
      ) : null}

      {message.type === "card" ? (
        <BodyEditor body={message} node={node} path={path} onCommit={(b) => onCommit({ ...b, type: "card" })} />
      ) : null}

      {message.type === "carousel" ? (
        <ListEditor
          label="Items"
          addLabel="Add item"
          items={message.items}
          max={10}
          min={1}
          make={(i) => ({ title: `Item ${i + 1}`, actions: [] })}
          onChange={(items) => set({ items })}
          render={(item, i) => (
            <BodyEditor
              body={item}
              node={node}
              path={`${path}.items[${i}]`}
              onCommit={(b) => set({ items: message.items.map((x, j) => (j === i ? b : x)) })}
            />
          )}
        />
      ) : null}

      {message.type === "custom" ? (
        <>
          <StringField
            label="Name"
            help="Your bridge receives it as the message type."
            value={message.name}
            check="required"
            path={`${path}.name`}
            node={node}
            rows={1}
            onCommit={(name) => set({ name })}
          />
          {str("Data", "data", message.data, "expression", "An expression; its value is sent as JSON.")}
        </>
      ) : null}

      <MessagePreview message={live} />
    </div>
  );
}

function BodyEditor({
  body,
  node,
  path,
  onCommit,
}: {
  body: Body;
  node: Node;
  path: string;
  onCommit: (b: Body) => void;
}) {
  const field = (label: string, key: "title" | "subtitle" | "imageUrl", required: boolean) => (
    <StringField
      label={label}
      value={body[key] ?? ""}
      check={required ? "required" : "text"}
      path={`${path}.${key}`}
      node={node}
      rows={1}
      onCommit={(v) => onCommit({ ...body, [key]: v })}
    />
  );
  return (
    <div className="flex flex-col gap-5">
      {field("Title", "title", true)}
      {field("Subtitle", "subtitle", false)}
      {field("Image address", "imageUrl", false)}
      <ListEditor<Action>
        label="Buttons"
        addLabel="Add button"
        items={body.actions}
        max={5}
        min={0}
        make={(i) => ({ type: "postback", label: `Button ${i + 1}`, value: `button_${i + 1}` })}
        onChange={(actions) => onCommit({ ...body, actions })}
        render={(a, i) => (
          <>
            <SegmentedControl
              label="Button type"
              value={a.type}
              options={[
                { value: "postback", label: "Reply" },
                { value: "url", label: "Link" },
                { value: "say", label: "Say" },
              ]}
              onChange={(type) =>
                onCommit({ ...body, actions: body.actions.map((x, j) => (j === i ? { ...x, type } : x)) })
              }
            />
            <StringField
              label="Label"
              value={a.label}
              check="required"
              path={`${path}.actions[${i}].label`}
              node={node}
              rows={1}
              onCommit={(label) =>
                onCommit({ ...body, actions: body.actions.map((x, j) => (j === i ? { ...x, label } : x)) })
              }
            />
            <StringField
              label={a.type === "url" ? "Address" : "Value"}
              value={a.value}
              check="required"
              path={`${path}.actions[${i}].value`}
              node={node}
              rows={1}
              onCommit={(value) =>
                onCommit({ ...body, actions: body.actions.map((x, j) => (j === i ? { ...x, value } : x)) })
              }
            />
          </>
        )}
      />
    </div>
  );
}

/**
 * A list of sub-forms with add, remove and move up/down. Changes to the list itself commit at once;
 * fields inside commit on blur.
 */
export function ListEditor<T>({
  label,
  addLabel,
  items,
  min,
  max,
  make,
  onChange,
  render,
}: {
  label: string;
  addLabel: string;
  items: readonly T[];
  min: number;
  max: number;
  make: (index: number) => T;
  onChange: (items: T[]) => void;
  render: (item: T, index: number) => React.ReactNode;
}) {
  const move = (i: number, by: number) => {
    const next = [...items];
    const [item] = next.splice(i, 1);
    if (item === undefined) return;
    next.splice(i + by, 0, item);
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="pb-3 text-small font-medium text-primary">{label}</legend>
      {items.map((item, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: list items are edited by position and have no id.
          key={i}
          className="flex flex-col gap-4 rounded-md border border-hairline p-5"
        >
          <div className="flex items-center justify-between">
            <span className="text-small text-tertiary tabular-nums">{i + 1}</span>
            <span className="flex gap-1">
              <IconAction label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
              </IconAction>
              <IconAction label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
              </IconAction>
              <IconAction
                label="Remove"
                disabled={items.length <= min}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <X className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
              </IconAction>
            </span>
          </div>
          {render(item, i)}
        </div>
      ))}
      {items.length < max ? (
        <Button
          size="compact"
          variant="ghost"
          icon={<Plus className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => onChange([...items, make(items.length)])}
          className="self-start"
        >
          {addLabel}
        </Button>
      ) : null}
    </fieldset>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-control-sm items-center justify-center rounded-xs text-secondary transition-colors hover:bg-subtle hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
