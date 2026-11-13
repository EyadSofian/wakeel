import type { Page, Route } from "@playwright/test";
import type {
  ApiKeyResponse,
  BotResponse,
  InvitationResponse,
  MemberResponse,
  Problem,
  SessionResponse,
  WorkspaceResponse,
  WorkspaceSummary,
} from "@wakeel/contracts";
import { SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { BOT, type CanvasFixture, canvasDraft } from "./canvas-fixtures";

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
];

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
    settings: {},
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
export async function mockApi(page: Page, state: MockState, canvas: CanvasFixture = "typical"): Promise<void> {
  const d = data(state);
  const draft = canvasDraft(state === "rtl" ? "rtl" : canvas);
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
    return json(route, 404, {
      ...internal,
      status: 404,
      code: "not_found",
      title: "We could not find that",
      fix: "Check the id.",
    });
  });
}
