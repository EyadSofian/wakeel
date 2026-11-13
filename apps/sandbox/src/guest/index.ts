/**
 * The seam for the guest API (task 3.3): scope injection and diffing, bridged `fetch`, tool calls,
 * `log`, `say` and `ctx`. The core runner calls `install` once per exec on the fresh context, before
 * the code runs, and drives the async loop through the session. Until 3.3 the guest gets nothing:
 * no globals beyond the language built-ins.
 *
 * Runs inside the runner thread, so it may import only QuickJS and relative files.
 */
import type { QuickJSContext } from "quickjs-emscripten-core";
import type { ExecJob } from "../runner/messages.ts";

/** How the guest layer talks to the caller through the pool, frame by frame. */
export interface HostChannel {
  /** Sends a `tool_call` or `log` frame to the caller. */
  send(frame: unknown): void;
  /** Receives the caller's frames for this exec (tool results). Returns an unsubscribe function. */
  onFrame(listener: (frame: unknown) => void): () => void;
}

export interface GuestSession {
  /** Host operations the guest is waiting for; while above zero, a pending promise is not a hang. */
  inFlight(): number;
  /** Resolves once a host operation has settled its promise inside the guest. */
  waitForHost(): Promise<void>;
  /** Variable writes to return as `scopePatches`. Read after the code's promise settled. */
  scopePatches(): Record<string, unknown>;
  /** Releases every handle the session holds; called before the context is disposed. */
  dispose(): void;
}

export interface GuestApi {
  install(context: QuickJSContext, job: ExecJob, channel: HostChannel): GuestSession;
}

/** Task 3.2: the language built-ins and nothing else. */
export const NO_GUEST_API: GuestApi = {
  install: () => ({
    inFlight: () => 0,
    waitForHost: () => Promise.resolve(),
    scopePatches: () => ({}),
    dispose: () => undefined,
  }),
};
