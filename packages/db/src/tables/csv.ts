import { AppError, type Column, Json, TABLE_LIMITS } from "@wakeel/contracts";
import type { Tx } from "../client";
import { insertRowsLocked, type NormaliseSearch, readTable, type TableScope } from "./repo";
import { presentTableRow } from "./rows";

function invalid(message: string): never {
  throw new AppError("table_row_invalid", { message });
}

/** CSV supports quoted commas, doubled quotes, embedded line breaks and both CRLF and LF. */
function records(input: string): string[][] {
  const source = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "bare" | "quoted" | "closed" = "bare";

  function emitField() {
    row.push(field);
    if (row.length > TABLE_LIMITS.columns) invalid("the CSV has too many columns");
    field = "";
    state = "bare";
  }

  function emitRow() {
    emitField();
    rows.push(row);
    if (rows.length > TABLE_LIMITS.insertBatch + 1) invalid("import up to 500 rows per CSV");
    row = [];
  }

  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (state === "quoted") {
      if (c !== '"') field += c;
      else if (source.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else state = "closed";
      continue;
    }
    if (c === ",") {
      emitField();
    } else if (c === "\n" || c === "\r") {
      emitRow();
      if (c === "\r" && source.charAt(i + 1) === "\n") i += 1;
    } else if (c === '"' && state === "bare" && !field.length) {
      state = "quoted";
    } else {
      if (state === "closed" || c === '"') invalid("check the quoting in the CSV");
      field += c;
    }
  }
  if (state === "quoted") invalid("close the quoted CSV field");
  if (row.length || field.length || state === "closed") emitRow();
  return rows;
}

function cell(column: Column, input: string): Json {
  if (input === "") return null;
  switch (column.type) {
    case "string":
    case "enum":
      return input;
    case "date":
      return input.trim();
    case "number": {
      const value = input.trim();
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) {
        return Number(value);
      }
      break;
    }
    case "boolean":
      if (input.trim() === "true") return true;
      if (input.trim() === "false") return false;
      break;
    case "json":
      try {
        return Json.parse(JSON.parse(input));
      } catch {
        break;
      }
  }
  return invalid(`check the CSV value in ${column.name}`);
}

/** Resolve headers and insert all CSV rows against the same locked schema. */
export async function importTableCsv(tx: Tx, key: TableScope, text: string, normalize: NormaliseSearch) {
  const table = await readTable(tx, key, true);
  const [header, ...body] = records(text);
  if (!header || !body.length) invalid("add a header followed by at least one data row");
  const columns = header.map((field) => {
    const column = table.columns.find((item) => item.name === field.trim());
    if (!column) invalid("a CSV header does not match a column name");
    return column;
  });
  if (new Set(columns.map((column) => column.id)).size !== columns.length) invalid("remove duplicate CSV headers");
  const rows = body.map((fields) => {
    if (fields.length !== columns.length) invalid("each CSV row needs one field per header");
    return Object.fromEntries(columns.map((column, index) => [column.id, cell(column, fields[index] ?? "")]));
  });
  return (await insertRowsLocked(tx, table, rows, normalize)).map((row) => presentTableRow(table, row));
}
