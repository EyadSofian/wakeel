/**
 * Tab appearance (design system §4 Tabs). Settings tabs are links, so the router renders them; this
 * gives the classes. The active tab gets the accent underline, which is one of the accent's few uses
 * (§2.1).
 */
export function tabClasses(active: boolean): string {
  return [
    "inline-flex h-topbar items-center border-b-2 px-1 text-body font-medium transition-colors",
    active ? "border-accent text-primary" : "border-transparent text-secondary hover:text-primary",
  ].join(" ");
}
