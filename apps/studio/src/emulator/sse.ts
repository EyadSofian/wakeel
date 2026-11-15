/**
 * Server-sent events from a `fetch` body. `EventSource` cannot POST or send the CSRF header, so the
 * emulator reads the response stream itself. Feed decoded text as it arrives; complete frames come
 * back in order. Only `event:` and `data:` matter here; comments and other fields are skipped.
 */
export interface SseFrame {
  event: string;
  data: string;
}

export class SseParser {
  #buffer = "";

  feed(chunk: string): SseFrame[] {
    this.#buffer += chunk.replace(/\r\n?/g, "\n");
    const frames: SseFrame[] = [];
    let end = this.#buffer.indexOf("\n\n");
    while (end !== -1) {
      const raw = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) frames.push({ event, data: data.join("\n") });
      end = this.#buffer.indexOf("\n\n");
    }
    return frames;
  }
}
