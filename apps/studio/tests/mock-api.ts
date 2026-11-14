import type { Page, Route } from "@playwright/test";
import type {
  ApiKeyResponse,
  BotResponse,
  BridgeDelivery,
  InvitationResponse,
  MemberResponse,
  Problem,
  SessionResponse,
  StudioConnection,
  WorkspaceResponse,
  WorkspaceSummary,
} from "@wakeel/contracts";
import { SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { BOT, type CanvasFixture, canvasDraft, variablesDraft } from "./canvas-fixtures";
import { type EmulatorScenario, emulatorState, sseBody, turnEvents, turnSpans } from "./emulator-fixtures";

/**
 * The mock API layer for the screenshot review (design system §8.1): every `/v1` call is answered
 * from these fixtures, so shots are deterministic. The e2e suite talks to the real api instead.
 */
export type MockState = "default" | "empty" | "loading" | "error" | "rtl" | "signed-out";

export const WS = "ws_01m7a256m0a13warwhczsjhx9g";
const T0 = "2026-11-02T09:30:00.000Z";
const owner = "usr_01m7a256m0a13warwhczsjhx9a";

const permissions = [
  "workspace.read",
  "workspace.update",
  "workspace.delete",
  "member.read",
  "member.invite",
  "member.update_role",
  "member.remove",
  "api_key.read",
  "api_key.create",
  "api_key.revoke",
  "audit.read",
  "bot.read",
  "bot.create",
  "bot.update",
  "bot.delete",
  "bot.publish",
  "connection.read",
  "connection.manage",
  "secret.read",
  "secret.write",
];

/** Connection ids the Connections screens open (task 5.5). */
export const CONN = "conn_01m7a256m0a13warwhczsjhx01";
export const CONN_DISABLED = "conn_01m7a256m0a13warwhczsjhx03";

/** Connections, keys and deliveries for the Connections screens (task 5.5). */
function connectionsData(state: MockState) {
  const rtl = state === "rtl";
  const empty = state === "empty";
  const base = {
    botId: BOT,
    target: "production" as const,
    subscribedEvents: ["message.created", "handoff.requested", "conversation.ended", "turn.completed"],
    createdAt: T0,
  };
  const connections: StudioConnection[] = [
    {
      ...base,
      id: CONN,
      name: rtl ? "محوّل Chatwoot الرئيسي" : "Chatwoot",
      status: "active",
      webhookUrl: empty ? null : "https://bridge.engosoft.com/wakeel/webhook",
      signingSecrets: empty ? [{ last4: "Q7mN" }] : [{ last4: "Q7mN" }, { last4: "c2Xe" }],
      consecutiveDead: 0,
      lastDelivery: empty ? null : { status: "delivered", at: "2026-11-13T18:31:00.000Z" },
    },
    {
      ...base,
      id: "conn_01m7a256m0a13warwhczsjhx02",
      name: rtl ? "واتساب فرع المعادي" : "WhatsApp staging",
      target: "draft",
      status: "paused",
      webhookUrl: "https://staging.engosoft.com/hooks/wakeel-whatsapp-with-a-long-path",
      signingSecrets: [{ last4: "k9Pw" }],
      consecutiveDead: 0,
      lastDelivery: { status: "failed", at: "2026-11-12T10:05:00.000Z" },
    },
    {
      ...base,
      id: CONN_DISABLED,
      name: rtl ? `تجربة قديمة ${longToken}` : "Old n8n flow",
      status: "disabled",
      webhookUrl: "https://n8n.example.com/webhook/7f3a",
      signingSecrets: [{ last4: "Zr4t" }],
      consecutiveDead: 20,
      lastDelivery: { status: "dead", at: "2026-11-11T22:40:00.000Z" },
    },
  ];
  const keys = empty
    ? []
    : [
        {
          id: "key_01m7a256m0a13warwhczsjhx01",
          name: rtl ? "المحوّل في الإنتاج" : "Production adapter",
          prefix: "wk_bridge_8f2kq1zd",
          createdBy: owner,
          lastUsedAt: "2026-11-13T18:30:00.000Z",
          revokedAt: null,
          createdAt: T0,
        },
        {
          id: "key_01m7a256m0a13warwhczsjhx02",
          name: rtl ? "اختبار محلي" : "Local testing",
          prefix: "wk_bridge_3mv0tc8s",
          createdBy: owner,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: "2026-11-10T08:00:00.000Z",
        },
      ];
  const conv = "conv_01m7a256m0a13warwhczsjhx77";
  const deliveries: BridgeDelivery[] = empty
    ? []
    : [
        {
          eventId: "evt_01m7a256m0a13warwhczsjhx09",
          eventType: "turn.completed",
          conversationId: conv,
          seq: 9,
          status: "delivered",
          attempt: 1,
          nextAttemptAt: null,
          responseStatus: 200,
          error: null,
        },
        {
          eventId: "evt_01m7a256m0a13warwhczsjhx08",
          eventType: "message.created",
          conversationId: conv,
          seq: 8,
          status: "delivered",
          attempt: 1,
          nextAttemptAt: null,
          responseStatus: 204,
          error: null,
        },
        {
          eventId: "evt_01m7a256m0a13warwhczsjhx07",
          eventType: "handoff.requested",
          conversationId: conv,
          seq: 7,
          status: "failed",
          attempt: 3,
          nextAttemptAt: "2026-11-13T18:42:00.000Z",
          responseStatus: 503,
          error: "webhook_rejected",
        },
        {
          eventId: "evt_01m7a256m0a13warwhczsjhx06",
          eventType: "message.created",
          conversationId: conv,
          seq: 6,
          status: "dead",
          attempt: 9,
          nextAttemptAt: null,
          responseStatus: null,
          error: "fetch_failed",
        },
        {
          eventId: "evt_01m7a256m0a13warwhczsjhx05",
          eventType: "conversation.ended",
          conversationId: conv,
          seq: 5,
          status: "dead",
          attempt: 9,
          nextAttemptAt: null,
          responseStatus: 301,
          error: "webhook_redirected",
        },
      ];
  return { connections, keys, deliveries };
}

/** The fixture set's long unbroken token, in a member name, to check truncation (design system §6). */
const longToken = SCREENSHOT_FIXTURES.find((f) => f.id === "long_token")?.text.slice(-24) ?? "X7Q9X7Q9X7Q9X7Q9X7Q9X7Q9";

function data(state: MockState) {
  const rtl = state === "rtl";
  const session: SessionResponse = {
    user: {
      id: owner,
      email: "eyad@engosoft.test",
      name: rtl ? "إياد سفيان" : "Eyad Sofian",
      emailVerified: true,
      locale: "en",
    },
    expiresAt: "2026-11-20T09:30:00.000Z",
    csrfToken: "mock-csrf-token-000000000000000000000000000",
  };
  const name = rtl ? "شركة إنجوسوفت للحلول الرقمية" : "Engosoft";
  const workspace: WorkspaceResponse = {
    id: WS,
    name,
    slug: "engosoft",
    plan: "free",
    region: "default",
    settings: state === "empty" ? {} : { defaultModel: "claude-sonnet-5-5", utilityModel: "claude-haiku-5-5" },
    createdAt: T0,
    updatedAt: T0,
    role: "owner",
    permissions,
  };
  const workspaces: WorkspaceSummary[] = [
    { id: WS, name, slug: "engosoft", role: "owner" },
    { id: "ws_01m7a256m0a13warwhczsjhx9h", name: rtl ? "مختبر الوكيل" : "Agency lab", slug: "lab", role: "admin" },
  ];
  const members: MemberResponse[] = [
    {
      id: "mem_01m7a256m0a13warwhczsjhx01",
      userId: owner,
      email: session.user.email,
      name: session.user.name,
      role: "owner",
      createdAt: T0,
    },
    {
      id: "mem_01m7a256m0a13warwhczsjhx02",
      userId: "usr_01m7a256m0a13warwhczsjhx02",
      email: "ahmed@engosoft.test",
      name: rtl ? "محمد عبد الرحمن" : "Ahmed Hassan",
      role: "admin",
      createdAt: "2026-11-04T12:00:00.000Z",
    },
    {
      id: "mem_01m7a256m0a13warwhczsjhx03",
      userId: "usr_01m7a256m0a13warwhczsjhx03",
      email: "sara@engosoft.test",
      name: rtl ? "سارة Al-Mansouri" : "Sara Mansour",
      role: "builder",
      createdAt: "2026-11-06T08:15:00.000Z",
    },
    {
      id: "mem_01m7a256m0a13warwhczsjhx04",
      userId: "usr_01m7a256m0a13warwhczsjhx04",
      email: "support.lead.with.a.long.address@engosoft.test",
      name: rtl ? `مُراجِع ${longToken}` : "Support lead with a long display name that needs room",
      role: "viewer",
      createdAt: "2026-11-10T16:45:00.000Z",
    },
  ];
  const invitations: InvitationResponse[] = [
    {
      id: "inv_01m7a256m0a13warwhczsjhx01",
      email: "new.builder@engosoft.test",
      role: "builder",
      invitedBy: owner,
      expiresAt: "2026-11-20T09:30:00.000Z",
      createdAt: "2026-11-13T09:30:00.000Z",
    },
  ];
  const apiKeys: ApiKeyResponse[] = [
    {
      id: "key_01m7a256m0a13warwhczsjhx01",
      name: rtl ? "مزامنة n8n مع Odoo" : "GitHub Actions",
      prefix: "wk_live_k3m9x2qa",
      scopes: ["workspace.read", "bot.read", "bot.update"],
      createdBy: owner,
      lastUsedAt: "2026-11-12T22:10:00.000Z",
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-11-03T10:00:00.000Z",
    },
    {
      id: "key_01m7a256m0a13warwhczsjhx02",
      name: rtl ? "تقارير Looker الأسبوعية" : "Weekly reporting",
      prefix: "wk_live_p7d2h8wn",
      scopes: ["workspace.read", "conversation.read"],
      createdBy: owner,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-11-08T14:20:00.000Z",
    },
    {
      id: "key_01m7a256m0a13warwhczsjhx03",
      name: "Old staging key",
      prefix: "wk_live_a1b2c3d4",
      scopes: ["workspace.read"],
      createdBy: owner,
      lastUsedAt: "2026-11-01T08:00:00.000Z",
      expiresAt: null,
      revokedAt: "2026-11-05T09:00:00.000Z",
      createdAt: "2026-10-20T09:00:00.000Z",
    },
  ];
  const bot = (n: number, name: string, published: boolean, updatedAt: string): BotResponse => ({
    id: n === 1 ? BOT : `bot_01m7a256m0a13warwhczsjhx0${n}`,
    name,
    slug: `bot-${n}`,
    defaultLocale: rtl ? "ar" : "en",
    publishedVersionId: published ? `ver_01m7a256m0a13warwhczsjhx0${n}` : null,
    createdAt: T0,
    updatedAt,
  });
  const bots: BotResponse[] = [
    bot(1, rtl ? "مساعد متجر إنجوسوفت" : "Store assistant", true, "2026-11-13T08:40:00.000Z"),
    bot(2, rtl ? "دعم العملاء — Arabic & English" : "Customer support", true, "2026-11-12T17:05:00.000Z"),
    bot(3, rtl ? "حجز المواعيد" : "Appointment booking", false, "2026-11-10T11:20:00.000Z"),
  ];
  return { session, workspace, workspaces, members, invitations, apiKeys, bots };
}

const internal: Problem = {
  type: "https://docs.example/errors/internal_error",
  title: "Something went wrong on our side",
  status: 500,
  code: "internal_error",
  fix: "Try again. If it continues, contact support with request id req_01m7a256m0a13warwhczsjhx9g.",
  requestId: "req_01m7a256m0a13warwhczsjhx9g",
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? "application/problem+json" : "application/json",
    body: JSON.stringify(body),
  });

/**
 * Answers `/v1/*` for `state`. Session and the switcher always load, so the frame is real. `canvas`
 * picks the draft the bot canvas opens; autosave PUTs succeed with the next revision.
 */
export async function mockApi(
  page: Page,
  state: MockState,
  canvas: CanvasFixture | "variables" = "typical",
  emulator: EmulatorScenario = "conversation",
): Promise<void> {
  let turns = 0;
  const d = data(state);
  const draft =
    canvas === "variables"
      ? variablesDraft(state === "rtl" ? "rtl" : state === "empty" ? "empty" : "default")
      : canvasDraft(state === "rtl" ? "rtl" : canvas);
  let rev = 3;
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/session") {
      return state === "signed-out"
        ? json(route, 401, {
            ...internal,
            status: 401,
            code: "unauthenticated",
            title: "You are not signed in",
            fix: "Sign in, or send a valid API key.",
          })
        : json(route, 200, d.session);
    }
    if (path === "/v1/auth/sign-in") {
      return json(route, 401, {
        ...internal,
        status: 401,
        code: "invalid_credentials",
        title: "The email or password is not correct",
        fix: "Check both and try again.",
      });
    }
    if (path === "/v1/workspaces") return json(route, 200, { data: d.workspaces, nextCursor: null });
    // The emulator (task 4.6): each message gets the scenario's next turn as an SSE body.
    if (path === "/v1/__mock/product.svg") {
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#d9dde3"/><circle cx="160" cy="90" r="44" fill="#9aa3ae"/></svg>',
      });
    }
    const emulatorBase = `/v1/workspaces/${WS}/bots/${BOT}/emulator/`;
    if (path.startsWith(emulatorBase)) {
      const method = route.request().method();
      if (method === "POST") {
        if (emulator === "running") return; // left pending: the turn is still running
        const sent = JSON.parse(route.request().postData() ?? "{}")?.message?.text ?? "";
        const body = sseBody(turnEvents(emulator, turns, sent), turnSpans(emulator, turns));
        turns += 1;
        return route.fulfill({ status: 200, contentType: "text/event-stream", body });
      }
      if (method === "PUT") return json(route, 200, {});
      if (path.endsWith("/state")) return json(route, 200, emulatorState(Math.max(0, turns - 1)));
    }
    // Screen data: never answers while loading, fails on error, empty lists on empty.
    if (state === "loading") return; // left pending on purpose
    if (state === "error") return json(route, 500, internal);
    if (path === `/v1/workspaces/${WS}`) return json(route, 200, d.workspace);
    if (path.endsWith("/members")) return json(route, 200, { data: d.members, nextCursor: null });
    if (path.endsWith("/invitations")) {
      return json(route, 200, { data: state === "empty" ? [] : d.invitations, nextCursor: null });
    }
    if (path.endsWith("/bots")) return json(route, 200, { data: state === "empty" ? [] : d.bots, nextCursor: null });
    const botBase = `/v1/workspaces/${WS}/bots/${BOT}`;
    if (path === botBase) {
      return json(route, 200, {
        ...d.bots[0],
        name: draft.manifest.name,
        docs: [
          { kind: "manifest", docId: "manifest", rev, name: draft.manifest.name, updatedAt: T0 },
          ...draft.workflows.map((w) => ({ kind: "workflow", docId: w.id, rev, name: w.name, updatedAt: T0 })),
        ],
      });
    }
    if (path.startsWith(`${botBase}/docs/`)) {
      const [kind, docId] = path.slice(`${botBase}/docs/`.length).split("/");
      if (route.request().method() === "PUT") {
        rev += 1;
        return json(route, 200, { kind, docId, rev, doc: JSON.parse(route.request().postData() ?? "{}").doc });
      }
      const doc = kind === "manifest" ? draft.manifest : draft.workflows.find((w) => w.id === docId);
      return json(route, 200, { kind, docId, rev, doc });
    }
    if (path.endsWith("/api-keys"))
      return json(route, 200, { data: state === "empty" ? [] : d.apiKeys, nextCursor: null });
    // Settings → Models (task 6.2).
    if (path === `/v1/workspaces/${WS}/model-keys`) {
      const set = state !== "empty";
      return json(route, 200, {
        data: [
          { provider: "anthropic", set, last4: set ? "Q2xk" : null, baseUrl: null, updatedAt: set ? T0 : null },
          { provider: "openai", set: false, last4: null, baseUrl: null, updatedAt: null },
          { provider: "google", set: false, last4: null, baseUrl: null, updatedAt: null },
          {
            provider: "openai-compatible",
            set,
            last4: set ? "9fZa" : null,
            baseUrl: set ? "https://llm.engosoft.com/v1/openai-compatible/with/a/long/path" : null,
            updatedAt: set ? "2026-11-10T08:00:00.000Z" : null,
          },
        ],
        nextCursor: null,
      });
    }
    if (path === `/v1/workspaces/${WS}/models`) {
      const keySet = state !== "empty";
      const model = (id: string, input: number, output: number) => ({
        id,
        provider: "anthropic",
        kind: "chat",
        contextWindow: 1_000_000,
        capabilities: { vision: true, caching: true, structuredOutput: true },
        autonomy: "untested",
        prices: { inputPerMTok: input, outputPerMTok: output },
        keySet,
      });
      return json(route, 200, {
        data: [model("claude-opus-5-5", 4, 20), model("claude-sonnet-5-5", 2, 10), model("claude-haiku-5-5", 0.1, 0.5)],
        nextCursor: null,
      });
    }
    // Connections (task 5.5).
    const connBase = `${botBase}/connections`;
    if (path.startsWith(connBase)) {
      const c = connectionsData(state);
      const rest = path.slice(connBase.length).split("/").filter(Boolean);
      const method = route.request().method();
      if (rest.length === 0) {
        return json(route, 200, { data: state === "empty" ? [] : c.connections, nextCursor: null });
      }
      const one = c.connections.find((x) => x.id === rest[0]);
      if (!one)
        return json(route, 404, {
          ...internal,
          status: 404,
          code: "not_found",
          title: "We could not find that",
          fix: "Check the id.",
        });
      if (rest.length === 1) return json(route, 200, one);
      if (rest[1] === "keys") return json(route, 200, { data: c.keys, nextCursor: null });
      if (rest[1] === "deliveries") {
        const dead = url.searchParams.get("status") === "dead";
        return json(route, 200, {
          data: dead ? c.deliveries.filter((x) => x.status === "dead") : c.deliveries,
          nextCursor: null,
        });
      }
      if (rest[1] === "test" && rest[2] === "messages" && method === "POST") {
        return json(route, 200, {
          turnId: "turn_01m7a256m0a13warwhczsjhx01",
          conversationId: "conv_01m7a256m0a13warwhczsjhx88",
          status: "completed",
          messages: [
            {
              id: "msg_01m7a256m0a13warwhczsjhx01",
              conversationId: "conv_01m7a256m0a13warwhczsjhx88",
              seq: 2,
              direction: "out",
              payload: {
                type: "text",
                text:
                  state === "rtl"
                    ? "أهلاً بيك! طلبك رقم 5678 اتشحن امبارح."
                    : "Hello! Your order 5678 shipped yesterday.",
                format: "markdown",
              },
              citations: [],
              createdAt: T0,
            },
          ],
          events: [],
        });
      }
      if (rest[1] === "test" && method === "POST") {
        return json(route, 200, { delivered: false, statusCode: 503, durationMs: 412, error: "webhook_rejected" });
      }
    }
    return json(route, 404, {
      ...internal,
      status: 404,
      code: "not_found",
      title: "We could not find that",
      fix: "Check the id.",
    });
  });
}
