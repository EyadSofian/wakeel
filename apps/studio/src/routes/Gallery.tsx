import { SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { Button, type Category, enterTransition, exitTransition, IconTile, useMotionTokens } from "@wakeel/ui";
import { CircleStop, Code, LayoutList, type LucideIcon, Plus, Sparkles, UserRound, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";

/**
 * /__gallery (design system §4): every token and primitive in both themes, the reference the
 * screenshot review checks against. Class names are written out in full so Tailwind can find them.
 */
export function Gallery() {
  return (
    <div className="flex flex-col">
      <Section
        id="colour"
        title="Colour"
        note="Neutral surfaces; the indigo accent marks selection, focus and the one primary action."
      >
        <ColourSection />
      </Section>
      <Section
        id="categories"
        title="Node categories"
        note="ADR-017. Only nodes, their ports and the node library use these colours."
      >
        <CategorySection />
      </Section>
      <Section id="type" title="Type" note="IBM Plex. Three weights; sentence case.">
        <TypeSection />
      </Section>
      <Section
        id="space"
        title="Space, radius and elevation"
        note="4 px grid, values in px. Shadows only on things that float."
      >
        <ShapeSection />
      </Section>
      <Section id="buttons" title="Buttons" note="One primary button per view.">
        <ButtonSection />
      </Section>
      <Section
        id="content"
        title="Bot and user content"
        note='Rendered with dir="auto"; the fixture set from packages/testing.'
      >
        <ContentSection />
      </Section>
      <Section id="motion" title="Motion" note="Fade and short travel on enter; fade on exit.">
        <MotionSection />
      </Section>
    </div>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} data-section={id} className="border-b border-hairline px-8 py-8">
      <h2 id={`${id}-title`} className="text-title text-primary">
        {title}
      </h2>
      <p className="mt-1 text-small text-secondary">{note}</p>
      <div className="mt-6">{children}</div>
    </section>
  );
}

const SURFACES = [
  { token: "--bg-canvas", className: "bg-canvas" },
  { token: "--bg-surface", className: "bg-surface" },
  { token: "--bg-subtle", className: "bg-subtle" },
  { token: "--bg-muted", className: "bg-muted" },
  { token: "--accent-subtle", className: "bg-accent-subtle" },
];

const TEXTS = [
  { token: "--text-primary", className: "text-primary", sample: "Main text" },
  { token: "--text-secondary", className: "text-secondary", sample: "Labels and secondary text" },
  { token: "--text-tertiary", className: "text-tertiary", sample: "Placeholders and metadata" },
  { token: "--accent-text", className: "text-accent-text", sample: "Links" },
];

const STATUSES = [
  { token: "--success", dot: "bg-success", label: "Live" },
  { token: "--warning", dot: "bg-warning", label: "2 warnings" },
  { token: "--error", dot: "bg-error", label: "Delivery failed" },
];

function ColourSection() {
  return (
    <div className="grid grid-cols-3 items-start gap-8">
      <dl className="flex flex-col gap-3">
        {SURFACES.map((s) => (
          <div key={s.token} className="flex items-center gap-4">
            <span className={`size-control rounded-xs border border-hairline ${s.className}`} aria-hidden="true" />
            <dt className="font-mono text-code-small text-secondary">{s.token}</dt>
          </div>
        ))}
      </dl>
      <dl className="flex flex-col gap-3 rounded-md border border-hairline bg-surface p-5">
        {TEXTS.map((t) => (
          <div key={t.token} className="flex items-baseline justify-between gap-4">
            <dd className={`text-body ${t.className}`}>{t.sample}</dd>
            <dt className="whitespace-nowrap font-mono text-code-small text-tertiary">{t.token}</dt>
          </div>
        ))}
      </dl>
      <dl className="flex flex-col gap-3">
        {STATUSES.map((s) => (
          <div key={s.token} className="flex items-center gap-3">
            <span className={`size-status-dot rounded-full ${s.dot}`} aria-hidden="true" />
            <dd className="min-w-0 flex-1 text-body text-primary">{s.label}</dd>
            <dt className="whitespace-nowrap font-mono text-code-small text-tertiary">{s.token}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

const TYPE_SCALE = [
  { name: "text-display", className: "text-display", use: "Sign-in and empty-state headlines" },
  { name: "text-heading", className: "text-heading", use: "Page titles" },
  { name: "text-title", className: "text-title", use: "Panel and dialog titles" },
  { name: "text-content", className: "text-content", use: "Emulator messages and long text" },
  { name: "text-body", className: "text-body", use: "Default UI text, inputs, menus" },
  { name: "text-small", className: "text-small", use: "Metadata and tooltips" },
  { name: "text-micro", className: "text-micro", use: "Badges and output labels" },
  { name: "code-body", className: "font-mono text-code-body", use: "const order = await tables.orders.get(id)" },
];

function TypeSection() {
  return (
    <div className="flex flex-col divide-y divide-hairline rounded-md border border-hairline bg-surface">
      {TYPE_SCALE.map((t) => (
        <div key={t.name} className="flex items-baseline gap-6 px-5 py-4">
          <span className="w-node shrink-0 font-mono text-code-small text-tertiary">{t.name}</span>
          <span className={`min-w-0 flex-1 truncate text-primary ${t.className}`}>{t.use}</span>
        </div>
      ))}
    </div>
  );
}

const SPACES = [
  { name: "1 · 2", className: "w-1" },
  { name: "2 · 4", className: "w-2" },
  { name: "3 · 6", className: "w-3" },
  { name: "4 · 8", className: "w-4" },
  { name: "5 · 12", className: "w-5" },
  { name: "6 · 16", className: "w-6" },
  { name: "7 · 20", className: "w-7" },
  { name: "8 · 24", className: "w-8" },
  { name: "9 · 32", className: "w-9" },
  { name: "10 · 40", className: "w-10" },
  { name: "11 · 48", className: "w-11" },
  { name: "12 · 64", className: "w-12" },
];

const RADII = [
  { name: "xs · 4", className: "rounded-xs", use: "Keycaps, counts" },
  { name: "sm · 8", className: "rounded-sm", use: "Controls, card rows" },
  { name: "md · 10", className: "rounded-md", use: "Toolbars, rail, banners" },
  { name: "lg · 14", className: "rounded-lg", use: "Nodes, tables, panels" },
  { name: "xl · 18", className: "rounded-xl", use: "Dialogs" },
];

const SHADOWS = [
  { name: "shadow-pop", className: "shadow-pop", use: "Menus, popovers, toasts" },
  { name: "shadow-drag", className: "shadow-drag", use: "A node being dragged" },
  { name: "shadow-modal", className: "shadow-modal", use: "Dialogs, palette" },
];

function ShapeSection() {
  return (
    <div className="grid grid-cols-3 items-start gap-8">
      <ul className="flex flex-col gap-2" aria-label="Space tokens, in px">
        {SPACES.map((s) => (
          <li key={s.name} className="flex items-center gap-4">
            <span className="w-12 shrink-0 whitespace-nowrap font-mono text-code-small text-tertiary">{s.name}</span>
            <span className={`h-icon-sm rounded-xs bg-strong ${s.className}`} aria-hidden="true" />
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap content-start gap-6">
        {RADII.map((r) => (
          <li key={r.name} className="flex flex-col gap-2">
            <span className={`block h-11 w-12 border border-strong bg-surface ${r.className}`} aria-hidden="true" />
            <span className="font-mono text-code-small text-tertiary">{r.name}</span>
            <span className="text-small text-secondary">{r.use}</span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-6">
        {SHADOWS.map((s) => (
          <li key={s.name} className={`rounded-md border border-hairline bg-surface px-5 py-4 ${s.className}`}>
            <span className="block font-mono text-code-small text-tertiary">{s.name}</span>
            <span className="block text-small text-secondary">{s.use}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CATEGORIES: { category: Category; label: string; icon: LucideIcon; nodes: string }[] = [
  { category: "trigger", label: "Trigger", icon: Zap, nodes: "Start, Entry, Trigger" },
  {
    category: "logic",
    label: "Logic",
    icon: LayoutList,
    nodes: "Standard node; message, question and condition cards",
  },
  { category: "ai", label: "AI", icon: Sparkles, nodes: "Autonomous node; AI cards" },
  { category: "tool", label: "Tool", icon: Code, nodes: "Code, knowledge, table and workflow cards; notes" },
  { category: "human", label: "Human", icon: UserRound, nodes: "Handoff; error handler" },
  { category: "flow", label: "Flow", icon: CircleStop, nodes: "End, Exit" },
];

function CategorySection() {
  return (
    <div className="grid grid-cols-3 gap-5">
      {CATEGORIES.map((c) => (
        <div key={c.category} className="flex items-center gap-5 rounded-lg border border-hairline bg-surface p-5">
          <IconTile category={c.category} icon={c.icon} size="lg" />
          <div className="flex min-w-0 flex-col">
            <span className="text-body font-semibold text-primary">{c.label}</span>
            <span className="text-small text-secondary">{c.nodes}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ButtonSection() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4" data-testid="button-row">
        <Button variant="primary">Publish</Button>
        <Button variant="secondary" icon={<Plus className="size-icon" strokeWidth={1.5} aria-hidden="true" />}>
          Add card
        </Button>
        <Button variant="ghost">Rename</Button>
        <Button variant="danger">Delete workflow</Button>
        <Button variant="secondary" disabled>
          Duplicate
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button size="compact">Compact · 28</Button>
        <Button>Default · 32</Button>
        <Button size="large">Large · 40</Button>
      </div>
    </div>
  );
}

function ContentSection() {
  return (
    <ul className="grid grid-cols-2 gap-x-8 gap-y-5">
      {SCREENSHOT_FIXTURES.map((f) => (
        <li key={f.id} className="flex min-w-0 flex-col gap-2" data-fixture={f.id}>
          <span className="text-small text-secondary">{f.label}</span>
          <p
            dir="auto"
            className="wrap-anywhere rounded-md border border-hairline bg-surface px-5 py-3 text-content text-primary"
          >
            {f.text}
          </p>
          <p dir="auto" className="truncate rounded-sm bg-subtle px-4 py-1 text-body text-secondary">
            {f.text}
          </p>
        </li>
      ))}
    </ul>
  );
}

function MotionSection() {
  const [open, setOpen] = useState(false);
  const tokens = useMotionTokens();
  return (
    <div className="flex flex-col items-start gap-4">
      <Button data-testid="motion-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide details" : "Show details"}
      </Button>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="details"
            data-testid="motion-panel"
            initial={{ opacity: 0, y: -tokens.travel }}
            animate={{ opacity: 1, y: 0, transition: enterTransition(tokens) }}
            exit={{ opacity: 0, transition: exitTransition(tokens) }}
            className="w-inspector rounded-md border border-hairline bg-surface px-5 py-4 shadow-pop"
          >
            <p className="text-body font-medium text-primary">Popover</p>
            <p className="mt-1 text-small text-secondary">Enters with spring.gentle and 8 px of travel.</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
