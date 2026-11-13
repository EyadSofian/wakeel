import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

/**
 * Table (design system §4 DataTable, §2.3): sticky header on `--bg-subtle`, 32 px rows, hairlines
 * between rows, numbers in tabular figures. Plain table markup, so screen readers get headers.
 */
export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <table aria-label={label} className="w-full border-collapse text-start text-body">
      {children}
    </table>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 bg-subtle">{children}</thead>;
}

export function Th({ className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={[
        "h-row-table whitespace-nowrap border-b border-hairline px-5 text-start text-small font-medium text-secondary",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Tr({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={["border-b border-hairline", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </tr>
  );
}

export function Td({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={["h-row-table whitespace-nowrap px-5 align-middle tabular-nums", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </td>
  );
}
