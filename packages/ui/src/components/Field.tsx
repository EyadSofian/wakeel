import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from "react";

/**
 * Field, Input and Select (design system §4). A field is a label, the control, and one line below
 * it: the error when there is one (what happened and how to fix it, §3.3), otherwise the help text.
 * The control is described by that line so screen readers read it too.
 */
export interface FieldProps {
  label: string;
  help?: ReactNode;
  error?: string;
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}

export function Field({ label, help, error, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? help;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-body font-medium text-primary">
        {label}
      </label>
      {children({
        id,
        ...(note === undefined ? {} : { "aria-describedby": noteId }),
        ...(error === undefined ? {} : { "aria-invalid": true }),
      })}
      {note === undefined ? null : (
        <p id={noteId} className={error === undefined ? "text-small text-secondary" : "text-small text-error"}>
          {note}
        </p>
      )}
    </div>
  );
}

const control =
  "h-control w-full rounded-sm border border-strong bg-surface px-4 text-body text-primary placeholder:text-tertiary transition-colors aria-invalid:border-error disabled:cursor-not-allowed disabled:opacity-50";

export function Input({
  className,
  size = "default",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: "default" | "large" }) {
  return (
    <input
      className={[control, size === "large" ? "h-control-lg" : "", className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={[control, "pe-6", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </select>
  );
}
