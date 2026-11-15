/** One server-sent event frame: `event: <type>` and `data: <json>` (bridge-api.openapi.yaml, sendMessage 200). */
export function sseFrame(type: string, data: unknown): string {
  // JSON has no raw line breaks, so one `data:` line carries it whole.
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
