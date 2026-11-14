import type { ReactNode } from "react";
import { type MdBlock, type MdInline, parseMarkdown } from "./parse-markdown";

/** Bot markdown as React elements (never HTML). Long tokens and URLs wrap instead of overflowing. */
export function Markdown({ text }: { text: string }) {
  return <div className="flex flex-col gap-3">{parseMarkdown(text).map(block)}</div>;
}

function block(b: MdBlock, i: number): ReactNode {
  if (b.t === "p")
    return (
      <p key={i} className="break-words">
        {b.c.map(inline)}
      </p>
    );
  const List = b.t === "ul" ? "ul" : "ol";
  return (
    <List key={i} className={`flex flex-col gap-1 ps-7 break-words ${b.t === "ul" ? "list-disc" : "list-decimal"}`}>
      {b.items.map((item, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond position.
        <li key={j}>{item.map(inline)}</li>
      ))}
    </List>
  );
}

function inline(n: MdInline, i: number): ReactNode {
  switch (n.t) {
    case "text":
      return n.v;
    case "br":
      return <br key={i} />;
    case "code":
      return (
        <code key={i} className="rounded-xs bg-muted px-1 font-mono text-code-small">
          {n.v}
        </code>
      );
    case "strong":
      return (
        <strong key={i} className="font-medium">
          {n.c.map(inline)}
        </strong>
      );
    case "em":
      return <em key={i}>{n.c.map(inline)}</em>;
    case "link":
      return (
        <a
          key={i}
          href={n.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="break-all text-accent-text underline underline-offset-2"
        >
          {n.c.map(inline)}
        </a>
      );
  }
}
