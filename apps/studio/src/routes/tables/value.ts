import { type Column, Json } from "@wakeel/contracts";

export function displayCell(value: Json | undefined) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parseCell(column: Column, value: string): Json {
  if (value === "") {
    if (column.required) throw new Error(`Enter a value for ${column.name}.`);
    return null;
  }
  switch (column.type) {
    case "number":
      if (value.trim() && Number.isFinite(Number(value))) return Number(value);
      throw new Error("Enter a number.");
    case "boolean":
      if (value === "true" || value === "false") return value === "true";
      throw new Error("Choose true or false.");
    case "json": {
      try {
        return Json.parse(JSON.parse(value));
      } catch {
        throw new Error("Enter valid JSON.");
      }
    }
    default:
      return value;
  }
}
