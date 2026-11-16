/**
 * Builds the Majed pilot bot (build-plan task 15.6) as a `wakeel.bot` export from
 * docs/pilot/majed/: the instructions, the knowledge-base ids, and the n8n tools that replaced the
 * Botpress Execute Code nodes. Prints the export as JSON on stdout, or the validation issues.
 *
 *   pnpm tsx tools/pilot/build-majed.ts --kb kb_… > majed.bot.json
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type BotDefinition,
  BotExport,
  newElementId,
  SCHEMA_VERSION,
  type Variable,
  validateDefinition,
} from "@wakeel/contracts";

const { values } = parseArgs({
  options: {
    kb: { type: "string" },
    model: { type: "string", default: "openai:gpt-6-luna" },
    utility: { type: "string", default: "openai:gpt-6-luna" },
  },
});
if (!values.kb) throw new Error("Pass --kb <knowledge base id>");
const kbId = values.kb;

const instructions = readFileSync(
  new URL("../../docs/pilot/majed/private/instructions.md", import.meta.url),
  "utf8",
).trim();

const id = {
  main: newElementId("wf"),
  start: newElementId("node"),
  preload: newElementId("node"),
  majed: newElementId("node"),
  sales: newElementId("node"),
  support: newElementId("node"),
  idle: newElementId("node"),
  exitSales: newElementId("exit"),
  exitSupport: newElementId("exit"),
};

const conv = (name: string, type: Variable["type"], description: string, extra: Partial<Variable> = {}): Variable =>
  ({ id: newElementId("var"), name, scope: "conversation", type, description, sensitive: false, ...extra }) as Variable;

const vars = {
  isEnrolled: conv("isEnrolled", "boolean", "Set at start from the website's user data: the visitor has courses."),
  userEmail: conv("userEmail", "string", "Email to send notes, reminders and quiz results to."),
  userFullName: conv("userFullName", "string", "Name from the website or the chat contact."),
  userCourses: conv("userCourses", "any", "Enrolled courses with progress, as the website sent them."),
  activeCourse: conv("activeCourse", "string", "The course the website says the user is studying."),
  pendingAction: conv("pendingAction", "string", "The offer or question awaiting the user's answer (continuity)."),
  lastCourseName: conv("lastCourseName", "string", "Arabic name of the last course or package whose link was sent."),
  quizIndex: conv("quizIndex", "number", "Current question number in an active quiz."),
  quizTotal: conv("quizTotal", "number", "Number of questions in the active quiz."),
  quizScore: conv("quizScore", "number", "Correct answers so far in the active quiz."),
};
const readOnly = new Set(["isEnrolled", "userCourses", "activeCourse"]);

/** Shared by the three n8n tools: the same webhook base and the same failure message. */
const postToN8n = (path: string, payload: string) => `const res = await fetch(env.N8N_WEBHOOK_BASE + "/${path}", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(${payload}),
});
if (!res.ok) throw new Error("The automation service answered " + res.status + ". Tell the user it did not go through and offer to try again later.");
return { sent: true };`;

const emailGuard = `const email = (conversation.userEmail || "").trim();
if (!email) throw new Error("conversation.userEmail is empty. Ask the user for an email first (EMAIL GUARD).");`;

const definition: BotDefinition = {
  schemaVersion: SCHEMA_VERSION,
  manifest: {
    name: "Majed",
    description: "Engosoft course advisor and closer. Pilot migration from Botpress (task 15.6).",
    defaultLocale: "ar",
    locales: ["ar", "en"],
    settings: {
      models: { default: values.model as string, utility: values.utility as string },
      inactivityTimeoutMinutes: 15,
      errorMessage: "عذراً، حدث خطأ غير متوقع. حاول مرة أخرى بعد قليل.",
      quotaMessage: "المساعد غير متاح مؤقتاً. حاول مرة أخرى لاحقاً.",
      coalesceWindowMs: 1_500,
      transcriptTokenBudget: 8_000,
      limits: { turnSeconds: 120, stepsPerTurn: 200 },
    },
    variables: Object.values(vars),
    configVars: [
      {
        key: "N8N_WEBHOOK_BASE",
        secret: false,
        description: "Base URL of Engosoft's n8n webhooks, without a trailing slash.",
      },
    ],
    mainWorkflowId: id.main,
  },
  workflows: [
    {
      id: id.main,
      name: "Main",
      kind: "main",
      inputs: [],
      outputs: [],
      variables: [],
      nodes: [
        { id: id.start, name: "Start", type: "start" },
        {
          id: id.preload,
          name: "Load website data",
          type: "standard",
          cards: [
            {
              id: newElementId("card"),
              type: "code",
              name: "Read user data",
              timeoutMs: 2_000,
              // The website pushes userData into Chatwoot custom attributes; the adapter adds the
              // contact's own name and email. Missing fields stay empty rather than failing the turn.
              source: `const a = user.attributes;
const str = (v) => (typeof v === "string" ? v.trim() : "");
conversation.userEmail = conversation.userEmail || str(a.userEmail) || str(a.email) || str(a.contactEmail);
conversation.userFullName = conversation.userFullName || str(a.userFullName) || str(a.fullName) || str(a.contactName);
conversation.activeCourse = str(a.activeCourse) || str(a.courseName);
let courses = a.enrolledCourses ?? a.userCourses ?? [];
if (typeof courses === "string") { try { courses = JSON.parse(courses); } catch { courses = []; } }
conversation.userCourses = Array.isArray(courses) ? courses : [];
const enrolled = a.isEnrolled === true || a.isEnrolled === "true";
conversation.isEnrolled = enrolled || conversation.userCourses.length > 0;`,
            },
          ],
        },
        {
          id: id.majed,
          name: "Majed",
          type: "autonomous",
          instructions,
          tools: [
            {
              id: newElementId("tool"),
              type: "kb_search",
              name: "searchKnowledge",
              description:
                "Search Engosoft's catalog, instructors, company facts, sales playbook and Majed policies (offers, package contents, scripts, website help). Use for course existence, links, instructors, package contents and offer wording. Not for greetings or general educational questions.",
              kbIds: [kbId],
              topK: 6,
            },
            {
              id: newElementId("tool"),
              type: "code",
              name: "saveNotes",
              description:
                "Email the user's organised study notes as a PDF. Only after showing the notes, passing the EMAIL GUARD and getting a yes.",
              input: {
                type: "object",
                properties: {
                  notes: { type: "string", description: "The organised notes, as shown to the user." },
                  courseName: { type: "string" },
                },
                required: ["notes"],
              },
              sideEffects: true,
              timeoutMs: 30_000,
              source: `${emailGuard}
${postToN8n("majed-save-notes", '{ notes: input.notes, fullName: conversation.userFullName || "", email, courseName: input.courseName || conversation.activeCourse || "" }')}`,
            },
            {
              id: newElementId("tool"),
              type: "code",
              name: "createCalendarEvent",
              description:
                "Send a one-hour study reminder to the user's Google Calendar. Only after confirming title, date and time and passing the EMAIL GUARD.",
              input: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  date: { type: "string", description: "YYYY-MM-DD, Cairo time" },
                  time: { type: "string", description: "HH:MM, 24-hour, Cairo time" },
                },
                required: ["title", "date", "time"],
              },
              sideEffects: true,
              timeoutMs: 30_000,
              source: `${emailGuard}
${postToN8n("majed-calendar-event", '{ eventTitle: input.title, eventDate: input.date, eventTime: input.time, email, fullName: conversation.userFullName || "", duration: 60, timezone: "Africa/Cairo" }')}`,
            },
            {
              id: newElementId("tool"),
              type: "code",
              name: "emailQuizResult",
              description:
                "Email the finished quiz (questions, answers, explanations) and score. Only after the quiz ends, the EMAIL GUARD and a yes.",
              input: {
                type: "object",
                properties: {
                  topic: { type: "string" },
                  score: { type: "string", description: 'Like "4/5"' },
                  content: {
                    type: "string",
                    description: "Every question, the user's answer, the correct answer and why.",
                  },
                },
                required: ["topic", "score", "content"],
              },
              sideEffects: true,
              timeoutMs: 30_000,
              source: `${emailGuard}
${postToN8n("majed-quiz-email", '{ quizContent: input.content, quizTopic: input.topic, quizScore: input.score, email, fullName: conversation.userFullName || "", courseName: conversation.activeCourse || "" }')}`,
            },
          ],
          variableAccess: Object.entries(vars).map(([name, v]) => ({
            variableId: v.id,
            mode: readOnly.has(name) ? "read" : "write",
          })),
          exits: [
            {
              id: id.exitSales,
              name: "salesHandoff",
              description:
                "Hand over to the sales team. LAST resort: explicit request for a human, accepted transfer after a genuine self-close, help completing an order, accepted custom or company training. Never on interest, questions or price asks.",
              schema: {
                type: "object",
                properties: {
                  summary: { type: "string", description: "One Arabic sentence for the agent." },
                  courseName: { type: "string" },
                },
                required: ["summary"],
              },
            },
            {
              id: id.exitSupport,
              name: "supportHandoff",
              description:
                "Hand over to support: complaint, technical or login problem the self-help did not fix, refund, certificate validity, renewal fee amount, payment or installment failure.",
              schema: {
                type: "object",
                properties: { summary: { type: "string", description: "One Arabic sentence for the agent." } },
                required: ["summary"],
              },
            },
          ],
          conversational: true,
          allowHandoff: false,
          maxIterations: 8,
          temperature: 0.4,
          messageTypes: ["text", "choice"],
          busyMessage: "لحظة من فضلك، أنهي طلبك السابق.",
        },
        {
          id: id.sales,
          name: "Sales handoff",
          type: "standard",
          cards: [
            {
              id: newElementId("card"),
              type: "handoff",
              reason: "sales: {{event.exit.data.courseName}} — {{event.exit.data.summary}}",
              summary: "auto",
              include: [vars.userEmail.id, vars.userFullName.id, vars.lastCourseName.id],
              message: {
                type: "text",
                text: "سيتم تحويلك الآن لأحد المختصّين في المبيعات. لحظات وسيكون معك.",
                format: "plain",
              },
            },
          ],
        },
        {
          id: id.support,
          name: "Support handoff",
          type: "standard",
          cards: [
            {
              id: newElementId("card"),
              type: "handoff",
              reason: "support: {{event.exit.data.summary}}",
              summary: "auto",
              include: [vars.userEmail.id, vars.userFullName.id],
              message: {
                type: "text",
                text: "سيتم تحويلك الآن لأحد ممثلي خدمة العملاء. لحظات وسيكون معك مختص.",
                format: "plain",
              },
            },
          ],
        },
        { id: id.idle, name: "On inactivity", type: "trigger", on: { kind: "inactivity" } },
        {
          id: newElementId("node"),
          name: "Follow-up message",
          type: "standard",
          cards: [
            {
              id: newElementId("card"),
              type: "say",
              name: "Follow up",
              // Same branches as the Botpress timeout flow, keyed on the continuity variable.
              message: {
                type: "text",
                format: "plain",
                text: `{{conversation.pendingAction === "sent_course_link" && conversation.lastCourseName ? "شفت تفاصيل دورة " + conversation.lastCourseName + "؟ تحب أوضّح لك نقطة معيّنة أو أساعدك في خطوة التسجيل؟ 😊" : conversation.pendingAction === "quiz_done" ? "جاهز نكمّل موضوع جديد أو نراجع المذاكرة؟ ممكن نعمل اختبار تاني 💪" : conversation.pendingAction === "explaining" ? "لو عندك أي سؤال تاني في الشرح، أنا هنا 👋" : "هل لا تزال تحتاج مساعدة؟ أنا هنا 😊"}}`,
              },
            },
            {
              id: newElementId("card"),
              type: "code",
              name: "Notify n8n",
              timeoutMs: 15_000,
              source: `try {
  await fetch(env.N8N_WEBHOOK_BASE + "/majed-timeout-handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: conversation.userFullName || "زائر",
      email: conversation.userEmail || "",
      phone: typeof user.attributes.contactPhone === "string" ? user.attributes.contactPhone : "",
      lastAction: conversation.pendingAction || "idle",
      lastCourseName: conversation.lastCourseName || "",
      source: "Majed Timeout",
    }),
  });
} catch (error) {
  log.warn("Timeout notification failed", { message: String(error) });
}`,
            },
          ],
        },
      ],
      edges: [],
      layout: {},
    },
  ],
};

// Edges after the nodes exist, so ids line up.
const wf = definition.workflows[0];
if (!wf) throw new Error("unreachable");
const followUp = wf.nodes.at(-1);
if (!followUp) throw new Error("unreachable");
wf.edges = [
  { id: newElementId("edge"), from: { nodeId: id.start, port: "next" }, to: { nodeId: id.preload } },
  { id: newElementId("edge"), from: { nodeId: id.preload, port: "next" }, to: { nodeId: id.majed } },
  { id: newElementId("edge"), from: { nodeId: id.majed, port: `exit:${id.exitSales}` }, to: { nodeId: id.sales } },
  { id: newElementId("edge"), from: { nodeId: id.majed, port: `exit:${id.exitSupport}` }, to: { nodeId: id.support } },
  { id: newElementId("edge"), from: { nodeId: id.idle, port: "next" }, to: { nodeId: followUp.id } },
];
wf.layout = Object.fromEntries(
  wf.nodes.map((n, i) => [n.id, { x: 120 + (i % 4) * 320, y: 120 + Math.floor(i / 4) * 260 }]),
);

const exported = BotExport.parse({
  format: "wakeel.bot",
  formatVersion: 1,
  exportedAt: new Date().toISOString(),
  definition,
});
const issues = validateDefinition(exported.definition, {});
const errors = issues.filter((i) => i.severity === "error");
for (const i of issues) console.error(`${i.severity} ${i.code} ${i.path ?? ""} ${i.message}`);
if (errors.length > 0) process.exit(1);
process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
