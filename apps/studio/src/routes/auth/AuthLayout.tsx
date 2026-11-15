import { BRAND } from "@wakeel/config/brand";
import { Brand, type Category, IconTile } from "@wakeel/ui";
import { ArrowRight, type LucideIcon, MessageSquare, Play, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Sign in and its siblings (design system §5.14, ADR-017): the form on the start side, and on the
 * end side a still of what the Studio builds, a small flow and the conversation it produces, in
 * Arabic, because that is what this product is for. The still is static markup, not a screenshot.
 */
export function AuthLayout({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh grid-cols-2 bg-surface">
      <div className="flex flex-col px-11 py-9">
        <Brand name={BRAND.name} />
        <div className="flex flex-1 items-center justify-center py-11">
          <div className="flex w-sign-in flex-col gap-8">
            <div className="flex flex-col gap-3">
              <h1 className="text-display text-primary">{heading}</h1>
              <p className="text-content text-secondary">Build, test and run agents that speak Arabic and English.</p>
            </div>
            {children}
          </div>
        </div>
      </div>
      <Preview />
    </main>
  );
}

function PreviewNode({
  category,
  icon,
  title,
  subtitle,
  children,
}: {
  category: Category;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-node flex-col rounded-lg border border-hairline bg-surface shadow-node">
      <div className="flex items-center gap-4 px-6 py-5">
        <IconTile category={category} icon={icon} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body font-semibold text-primary">{title}</span>
          <span className="truncate text-small text-secondary">{subtitle}</span>
        </div>
      </div>
      {children ? <div className="flex flex-col gap-2 border-t border-hairline p-4">{children}</div> : null}
    </div>
  );
}

function Row({ children, port }: { children: ReactNode; port?: Category }) {
  return (
    <div className="flex h-row-card items-center justify-between gap-4 rounded-sm bg-subtle px-5 text-small text-secondary">
      <span dir="auto" className="truncate">
        {children}
      </span>
      {port ? <span aria-hidden="true" className={`size-status-dot shrink-0 rounded-full ${dotClass[port]}`} /> : null}
    </div>
  );
}

const dotClass: Record<Category, string> = {
  trigger: "bg-cat-trigger",
  logic: "bg-cat-logic",
  ai: "bg-cat-ai",
  tool: "bg-cat-tool",
  human: "bg-cat-human",
  flow: "bg-cat-flow",
};

function Bubble({ from, children }: { from: "user" | "bot"; children: ReactNode }) {
  return (
    <p
      dir="auto"
      className={[
        "max-w-node rounded-lg px-6 py-4 text-content",
        from === "user"
          ? "self-end bg-accent text-on-accent"
          : "self-start border border-hairline bg-surface text-primary",
      ].join(" ")}
    >
      {children}
    </p>
  );
}

function Preview() {
  return (
    <aside
      aria-hidden="true"
      className="flex flex-col justify-center gap-9 overflow-hidden border-s border-hairline bg-canvas px-11 py-11"
    >
      <div className="flex items-start gap-5">
        <PreviewNode category="trigger" icon={Play} title="Start" subtitle="A customer writes in" />
        <ArrowRight className="mt-9 size-icon shrink-0 text-tertiary" strokeWidth={1.75} />
        <PreviewNode category="ai" icon={Sparkles} title="مساعد الطلبات" subtitle="Autonomous node">
          <Row>ساعد العميل يتابع طلبه</Row>
          <Row port="ai">resolved</Row>
          <Row port="ai">needs_person</Row>
        </PreviewNode>
      </div>
      <div className="flex max-w-inspector-max flex-col gap-4 rounded-xl border border-hairline bg-subtle p-6">
        <span className="flex items-center gap-3 text-small text-secondary">
          <MessageSquare className="size-icon-sm" strokeWidth={1.75} />
          Test chat
        </span>
        <Bubble from="user">طلبي رقم ٤٨٢١٣ وصل لفين؟</Bubble>
        <Bubble from="bot">طلبك خرج من المخزن النهارده، ومتوقع يوصلك خلال يومين.</Bubble>
      </div>
    </aside>
  );
}
