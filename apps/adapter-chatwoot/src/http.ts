/** The adapter's outbound HTTP: one function so tests replace it with an in-process fake. */
export type HttpCall = (request: {
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}) => Promise<{ status: number; body: unknown }>;

export const fetchHttp: HttpCall = async ({ method, url, headers, body, timeoutMs = 10_000 }) => {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Non-JSON bodies (HTML error pages) stay as text for the error message.
  }
  return { status: res.status, body: parsed };
};

/** A failed call to Chatwoot or the platform. Carries no credentials, only where and what status. */
export class UpstreamError extends Error {
  constructor(
    readonly target: "chatwoot" | "bridge",
    readonly status: number,
    readonly path: string,
  ) {
    super(`${target} answered ${status} for ${path}`);
  }
  /** 4xx other than 408/429 will not succeed on a retry. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}
