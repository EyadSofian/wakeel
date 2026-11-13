import { timingSafeEqual } from "node:crypto";
import { AppError, type AuthUser, newId, type SignInRequest, type SignUpRequest } from "@wakeel/contracts";
import { accounts, type Database, sessions, users, verifications } from "@wakeel/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { Redis } from "ioredis";
import { csrfTokenFor } from "./csrf";
import { createSignInLimiter } from "./rate-limit";

/**
 * Studio sign-in (task 1.2, ADR-001, ADR-015). better-auth owns password hashing and sessions;
 * this module is the only place that imports it. It maps better-auth's errors to our codes, adds
 * the CSRF token and the per-email failure limit, and never exposes better-auth types.
 */

/** What the auth service needs from an HTTP request. */
export interface RequestContext {
  /** Incoming headers; `cookie`, `user-agent` and `origin` are read. */
  headers: Headers;
  /** Client address as the api resolved it (proxy-aware). Replaces any client-sent forwarding header. */
  ip: string;
}

export interface SessionView {
  user: AuthUser;
  sessionId: string;
  expiresAt: Date;
  csrfToken: string;
}

export interface AuthResult<T> {
  value: T;
  /** `Set-Cookie` values to send with the response. */
  setCookie: string[];
}

export interface AuthService {
  signUp(input: SignUpRequest, ctx: RequestContext): Promise<AuthResult<SessionView>>;
  signIn(input: SignInRequest, ctx: RequestContext): Promise<AuthResult<SessionView>>;
  signOut(ctx: RequestContext): Promise<AuthResult<void>>;
  /** The signed-in session, or `undefined` without a valid cookie. May refresh the cookie. */
  getSession(ctx: RequestContext): Promise<AuthResult<SessionView | undefined>>;
  /** Checks an `X-CSRF-Token` value against the session. */
  verifyCsrf(session: SessionView, presented: string | undefined): boolean;
}

export interface AuthOptions {
  db: Database;
  redis: Redis;
  /** `AUTH_SECRET`: signs session cookies and CSRF tokens. */
  secret: string;
  /** `API_PUBLIC_URL`. */
  baseUrl: string;
  /** `STUDIO_ORIGIN`: the only origin allowed to use cookies. */
  studioOrigin: string;
  /** `limits.signInFailuresPerMinute`. */
  signInFailuresPerMinute: number;
}

const SESSION_DAYS = 7;
const DAY_SECONDS = 86_400;
const ID_PREFIX = { user: "usr", session: "ses", account: "acc", verification: "vrf" } as const;

export function createAuthService(options: AuthOptions): AuthService {
  const limiter = createSignInLimiter(options.redis, { maxFailures: options.signInFailuresPerMinute });

  const auth = betterAuth({
    appName: "wakeel",
    baseURL: options.baseUrl,
    secret: options.secret,
    database: drizzleAdapter(options.db.platform, {
      provider: "pg",
      schema: { users, sessions, accounts, verifications },
      usePlural: true,
      transaction: true,
    }),
    user: {
      additionalFields: {
        locale: { type: "string", required: false, defaultValue: "en", input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: { expiresIn: SESSION_DAYS * DAY_SECONDS, updateAge: DAY_SECONDS },
    trustedOrigins: [options.studioOrigin],
    // Our own limiter (Redis, shared by replicas); better-auth's is in-memory per process.
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "wakeel",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
      database: {
        generateId: ({ model }) => {
          const prefix = ID_PREFIX[model as keyof typeof ID_PREFIX];
          if (prefix === undefined) throw new Error(`No id prefix for better-auth model ${model}`);
          return newId(prefix);
        },
      },
    },
    telemetry: { enabled: false },
    logger: { disabled: true },
  });

  /** Only the headers better-auth needs, with the client address we resolved. */
  const forward = (ctx: RequestContext): Headers => {
    const headers = new Headers();
    for (const name of ["cookie", "user-agent", "origin"]) {
      const value = ctx.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("x-forwarded-for", ctx.ip);
    return headers;
  };

  const view = (user: Record<string, unknown>, session: { id: string; token: string; expiresAt: Date }) => ({
    user: {
      id: String(user["id"]),
      email: String(user["email"]),
      name: String(user["name"]),
      emailVerified: Boolean(user["emailVerified"]),
      locale: typeof user["locale"] === "string" ? user["locale"] : "en",
    },
    sessionId: session.id,
    expiresAt: new Date(session.expiresAt),
    csrfToken: csrfTokenFor(options.secret, session.token),
  });

  /** Reads the session that a sign-up or sign-in response cookie just created. */
  const sessionFromCookies = async (setCookie: string[], ctx: RequestContext): Promise<SessionView> => {
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const headers = forward(ctx);
    headers.set("cookie", cookie);
    const found = await auth.api.getSession({ headers });
    if (!found) throw new Error("better-auth did not create a session");
    return view(found.user, found.session);
  };

  return {
    async signUp(input, ctx) {
      try {
        const { headers } = await auth.api.signUpEmail({
          body: { name: input.name, email: input.email, password: input.password },
          headers: forward(ctx),
          returnHeaders: true,
        });
        const setCookie = headers.getSetCookie();
        return { value: await sessionFromCookies(setCookie, ctx), setCookie };
      } catch (e) {
        throw mapError(e);
      }
    },

    async signIn(input, ctx) {
      await limiter.check(input.email);
      try {
        const { headers } = await auth.api.signInEmail({
          body: { email: input.email, password: input.password, rememberMe: true },
          headers: forward(ctx),
          returnHeaders: true,
        });
        await limiter.reset(input.email);
        const setCookie = headers.getSetCookie();
        return { value: await sessionFromCookies(setCookie, ctx), setCookie };
      } catch (e) {
        const mapped = mapError(e);
        if (mapped instanceof AppError && mapped.code === "invalid_credentials")
          await limiter.recordFailure(input.email);
        throw mapped;
      }
    },

    async signOut(ctx) {
      try {
        const { headers } = await auth.api.signOut({ headers: forward(ctx), returnHeaders: true });
        return { value: undefined, setCookie: headers.getSetCookie() };
      } catch (e) {
        throw mapError(e);
      }
    },

    async getSession(ctx) {
      const { headers, response } = await auth.api.getSession({ headers: forward(ctx), returnHeaders: true });
      return {
        value: response ? view(response.user, response.session) : undefined,
        setCookie: headers.getSetCookie(),
      };
    },

    verifyCsrf(session, presented) {
      return presented !== undefined && sameToken(session.csrfToken, presented);
    },
  };
}

function sameToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** better-auth error codes we expect, mapped to the catalogue. Anything else is a bug: rethrown. */
function mapError(error: unknown): unknown {
  if (!(error instanceof APIError)) return error;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return new AppError("invalid_credentials", {}, { cause: error });
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return new AppError("email_taken", {}, { cause: error });
    case "PASSWORD_TOO_SHORT":
    case "PASSWORD_TOO_LONG":
      return new AppError(
        "validation_failed",
        {},
        { cause: error, errors: [{ path: "password", code: "too_short_or_long", message: "Use 8 to 128 characters" }] },
      );
    case "INVALID_EMAIL":
      return new AppError(
        "validation_failed",
        {},
        { cause: error, errors: [{ path: "email", code: "invalid_format", message: "Enter a valid email address" }] },
      );
    default:
      return error;
  }
}
