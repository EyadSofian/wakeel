import { useId } from "react";

/** Switch (design system §4): a two-state control with its label and one line of help. */
export function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-5">
      <label htmlFor={id} className="flex flex-col gap-1">
        <span className="text-small font-medium text-primary">{label}</span>
        {hint ? <span className="text-small text-tertiary">{hint}</span> : null}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-7 w-10 shrink-0 items-center rounded-full p-1 transition-colors",
          checked ? "justify-end bg-accent" : "justify-start bg-muted",
        ].join(" ")}
      >
        <span aria-hidden="true" className="size-6 rounded-full bg-surface shadow-pop" />
      </button>
    </div>
  );
}

/** SegmentedControl (design system §4): two to five mutually exclusive choices in one row. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm bg-muted p-1">
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: an ARIA radio group of buttons (APG segmented control), not form radios.
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={[
            "h-control-sm rounded-xs px-5 text-small font-medium transition-colors",
            o.value === value ? "bg-surface text-primary shadow-node" : "text-secondary hover:text-primary",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
