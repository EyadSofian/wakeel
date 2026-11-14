import { BridgeEvent, EmulatorStateResponse, Problem, Span, Trace } from "@wakeel/contracts";
import { ApiError, api, csrfHeaders, networkProblem } from "../api/client";
import type { EmulatorTransport } from "./controller";
import { SseParser } from "./sse";

/** The emulator routes of one bot (ADR-025). */
export const emulatorBase = (workspaceId: string, botId: string) =>
  `/v1/workspaces/${workspaceId}/bots/${botId}/emulator`;

/**
 * The emulator's transport over fetch. Streamed requests read the SSE body as it arrives, because
 * `EventSource` can neither POST nor send the CSRF header; each frame is parsed as a Bridge event,
 * and a frame that does not parse is skipped rather than breaking the transcript.
 */
export const fetchTransport = (workspaceId: string): EmulatorTransport => ({
  async stream(path, body, onEvent, onSpan) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...csrfHeaders() },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(networkProblem());
    }
    if (!res.ok) {
      const parsed = Problem.safeParse(await res.json().catch(() => undefined));
      throw new ApiError(parsed.success ? parsed.data : networkProblem());
    }
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(value)) {
        let json: unknown;
        try {
          json = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (frame.event === "trace.span") {
          const span = Span.safeParse(json);
          if (span.success) onSpan(span.data);
          continue;
        }
        const event = BridgeEvent.safeParse(json);
        if (event.success) onEvent(event.data);
      }
    }
  },
  put: (path, body) => api("PUT", path, body),
  get: async (path) => EmulatorStateResponse.parse(await api("GET", path)),
  trace: async (turnId) => Trace.parse(await api("GET", `/v1/workspaces/${workspaceId}/turns/${turnId}/trace`)),
});
