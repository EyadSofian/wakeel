import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Button (design system §4). Appearance only from tokens. One primary button per view: the accent
 * fill is reserved for the view's main action (§2.1).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "compact" | "default" | "large";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon, 16 px (§2.3). */
  icon?: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-4 rounded-sm font-medium whitespace-nowrap select-none transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover disabled:hover:bg-accent",
  secondary:
    "bg-surface text-primary border border-hairline hover:border-strong hover:bg-subtle active:bg-muted disabled:hover:bg-surface",
  ghost: "bg-transparent text-secondary hover:bg-subtle hover:text-primary active:bg-muted",
  danger:
    "bg-surface text-error border border-hairline hover:border-strong hover:bg-error-subtle active:bg-error-subtle",
};

const sizes: Record<ButtonSize, string> = {
  compact: "h-control-sm px-5 text-small",
  default: "h-control px-6 text-body",
  large: "h-control-lg px-7 text-content",
};

/** Button appearance for elements that navigate (a link styled as a button), so no button is nested in a link. */
export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "default"): string {
  return [base, variants[variant], sizes[size]].join(" ");
}

export function Button({ variant = "secondary", size = "default", icon, className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={[buttonClasses(variant, size), className].filter(Boolean).join(" ")} {...rest}>
      {icon}
      {children}
    </button>
  );
}
