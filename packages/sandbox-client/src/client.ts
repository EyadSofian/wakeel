import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { AppError, ERRORS, type ErrorCode, type FieldError } from "@wakeel/contracts";
import {
  type ExecOutcome,
  type ExecRequestFrameInput,
  type LogFrame,
  NDJSON_CONTENT_TYPE,
  ServiceFrame,
  type ToolCallName,
  type ToolResultFrame,
} from "./protocol";

/**
 * The worker's way into the sandbox service (architecture §5.1, ADR-019 §10, ADR-023). One exec is
 * one `POST /exec`: the request frame first, then a `tool_result` line for every `tool_call` the
 * service sends, until the `result` or `error` frame ends it. Node's `http` keeps both directions
 * open at once, which `fetch` cannot.
 */

export interface ToolCall {
  callId: string;
  name: ToolCallName;
  input: unknown;
}

export interface ExecHandlers {
  /**
   * Answers a platform call (`say`, `tables.*`, `kb.search`, `ai.*`). Throw an `AppError` to fail the
   * call with its code and title; any other throw reaches the guest as `internal_error` without its
   * message, so nothing internal leaks into tenant code.
   */
  onToolCall(call: ToolCall): Promise<unknown>;
  /** Guest log lines, secrets already redacted by the sandbox. */
  onLog?(frame: LogFrame): void;
  /** Aborting closes the stream; the service cancels the exec. */
  signal?: AbortSignal;
}

export interface SandboxClient {
  /**
   * Runs one exec. Resolves with its `result` or `error` frame. Rejects with an `AppError` when the
   * service refuses it (`validation_failed`, `rate_limited`, `payload_too_large`) or cannot be
   * reached (`internal_error`), or with the abort reason.
   */
  exec(request: ExecRequestFrameInput, handlers: ExecHandlers): Promise<ExecOutcome>;
}

export interface SandboxClientOptions {
  /** Base URL of the sandbox service, for example http://sandbox:4300. */
  url: string;
}

const isErrorCode = (code: unknown): code is ErrorCode => typeof code === "string" && Object.hasOwn(ERRORS, code);

/** Turns a handler failure into the answer the guest sees. */
function failure(error: unknown): ToolResultFrame & { ok: false } {
  if (error instanceof AppError)
    return { t: "tool_result", callId: "", ok: false, error: { code: error.code, message: error.title } };
  return { t: "tool_result", callId: "", ok: false, error: { code: "internal_error", message: "the call failed" } };
}

async function problemOf(res: IncomingMessage): Promise<AppError> {
  const chunks: Buffer[] = [];
  for await (const chunk of res as AsyncIterable<Buffer>) chunks.push(chunk);
  try {
    const problem = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      code?: unknown;
      detail?: unknown;
      errors?: unknown;
    };
    if (isErrorCode(problem.code)) {
      const options: { detail?: string; errors?: FieldError[] } = {};
      if (typeof problem.detail === "string") options.detail = problem.detail;
      if (Array.isArray(problem.errors)) options.errors = problem.errors as FieldError[];
      return new AppError(problem.code, {}, options);
    }
  } catch {
    // Not a problem document: fall through.
  }
  return new AppError("internal_error", {}, { detail: `the sandbox answered ${res.statusCode}` });
}

export function createSandboxClient(options: SandboxClientOptions): SandboxClient {
  const endpoint = new URL("/exec", options.url);
  const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;

  return {
    exec: (frame, handlers) =>
      new Promise<ExecOutcome>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          handlers.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const req = send(endpoint, { method: "POST", headers: { "content-type": NDJSON_CONTENT_TYPE } });
        const onAbort = () => {
          finish(() => reject(handlers.signal?.reason));
          req.destroy();
        };
        if (handlers.signal?.aborted) {
          onAbort();
          return;
        }
        handlers.signal?.addEventListener("abort", onAbort, { once: true });

        const answer = (result: ToolResultFrame) => {
          if (!done && !req.writableEnded) req.write(`${JSON.stringify(result)}\n`);
        };

        req.on("error", () =>
          finish(() => reject(new AppError("internal_error", {}, { detail: "the sandbox could not be reached" }))),
        );
        req.on("response", (res) => {
          if (res.statusCode !== 200) {
            void problemOf(res).then((error) => finish(() => reject(error)));
            req.end();
            return;
          }
          let buffer = "";
          const onLine = (line: string) => {
            if (line.trim() === "") return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              parsed = undefined;
            }
            const result = ServiceFrame.safeParse(parsed);
            if (!result.success) {
              finish(() =>
                reject(new AppError("internal_error", {}, { detail: "the sandbox sent a frame that is not valid" })),
              );
              req.destroy();
              return;
            }
            const out = result.data;
            if (out.t === "tool_call") {
              handlers.onToolCall({ callId: out.callId, name: out.name, input: out.input }).then(
                (value) => answer({ t: "tool_result", callId: out.callId, ok: true, value: value ?? null }),
                (error: unknown) => answer({ ...failure(error), callId: out.callId }),
              );
              return;
            }
            if (out.t === "log") {
              handlers.onLog?.(out);
              return;
            }
            finish(() => resolve(out));
            req.end();
          };
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
              onLine(buffer.slice(0, at));
              buffer = buffer.slice(at + 1);
            }
          });
          res.on("end", () => {
            onLine(buffer);
            finish(() => reject(new AppError("internal_error", {}, { detail: "the sandbox closed the stream early" })));
          });
          res.on("error", () =>
            finish(() => reject(new AppError("internal_error", {}, { detail: "the sandbox stream failed" }))),
          );
        });
        req.write(`${JSON.stringify(frame)}\n`);
      }),
  };
}
