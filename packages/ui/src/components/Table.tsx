import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

/**
 * Table (design system §4 DataTable, ADR-017): a bordered, rounded block with a quiet header, 52 px
 * rows, hairlines between rows, numbers in tabular figures. Plain table markup, so screen readers get
 * headers.
 */
export function Table({ label, fixed = false, children }: { label: string; fixed?: boolean; children: ReactNode }) {
  // `fixed`: column widths come from the header cells, so stacked tables line up.
  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      <table
        aria-label={label}
        className={["w-full border-collapse text-start text-body", fixed ? "table-fixed" : ""].join(" ")}
      >
        {children}
      </table>
    </div>
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
        "h-control-lg whitespace-nowrap border-b border-hairline px-7 text-start text-small font-medium text-secondary",
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
    <tr
      className={["border-b border-hairline transition-colors last:border-b-0 hover:bg-subtle", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={["h-row-table whitespace-nowrap px-7 align-middle tabular-nums", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </td>
  );
}
