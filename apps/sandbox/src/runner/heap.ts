/**
 * Safe copies from the host into the guest's heap (docs/security/sandbox-review.md §3).
 *
 * quickjs-emscripten copies a string into WASM memory with `_malloc` and writes it without checking
 * the pointer. When the heap is full, `_malloc` returns 0 and the text is written from address 0
 * upwards, over the module's static data, which starts at byte 1024. A guest that fills its heap and
 * then awaits a large tool result would corrupt the module for every later exec on that runner.
 *
 * So every copy of outside text (scopes, source, answers) is preceded by a probe, whatever its
 * size: the guest allocates an `ArrayBuffer` of twice the size plus 64 KB through QuickJS's own
 * allocator, which checks for failure, and frees it at once. No guest code runs between the probe
 * and the copy, so the host's `_malloc` finds the space the probe held. Even a short text is probed:
 * written at address 0 it would sit where a failed `_malloc` of a value box points, and could be
 * read back as a value. The library's own short copies (property names such as "message") are
 * fixed text under 1 KB and land in the first kilobyte, which nothing else uses.
 *
 * Runs inside the runner thread: imports only QuickJS types.
 */
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";

/**
 * The probe holds this much more than the text: the host's copy and QuickJS's own copy of it are two
 * allocations, each with allocator overhead.
 */
const PROBE_SLACK_BYTES = 64 * 1024;

const BOOTSTRAP = "(function (AB) { return function (n) { return new AB(n); }; })(ArrayBuffer)";

export interface HeapGuard {
  /** True when `bytes` can be copied in now. Checked with a guest allocation freed at once. */
  room(bytes: number): boolean;
  /** A guest string holding `text`, or undefined when the heap has no room for it. */
  newString(text: string): QuickJSHandle | undefined;
  /**
   * A guest `ArrayBuffer` of `bytes` that only the host holds, or undefined when it does not fit.
   * Allocated by QuickJS, not copied in, so it needs no probe.
   */
  hold(bytes: number): QuickJSHandle | undefined;
  dispose(): void;
}

/**
 * Prepares the guard. Must run before any guest code: it captures the intrinsic `ArrayBuffer`
 * constructor in a closure the guest can never reach.
 */
export function createHeapGuard(ctx: QuickJSContext): HeapGuard {
  const made = ctx.evalCode(BOOTSTRAP, "heap.js", { type: "global", strict: true });
  if (made.error) {
    made.error.dispose();
    throw new Error("the heap guard could not be installed");
  }
  const allocate = made.value;

  const hold = (bytes: number): QuickJSHandle | undefined => {
    const size = ctx.newNumber(bytes);
    try {
      const result = ctx.callFunction(allocate, ctx.undefined, size);
      if (result.error) {
        result.error.dispose();
        return undefined;
      }
      return result.value;
    } finally {
      size.dispose();
    }
  };

  const room = (bytes: number): boolean => {
    const probe = hold(2 * bytes + PROBE_SLACK_BYTES);
    if (!probe) return false;
    probe.dispose();
    return true;
  };

  return {
    room,
    hold,
    newString: (text) => {
      if (!room(Buffer.byteLength(text, "utf8"))) return undefined;
      const handle = ctx.newString(text);
      // QuickJS's own copy can still fail; its handle is then not a string.
      if (ctx.typeof(handle) === "string") return handle;
      handle.dispose();
      return undefined;
    },
    dispose: () => allocate.dispose(),
  };
}
