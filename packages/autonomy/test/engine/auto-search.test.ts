import {
  AppError,
  AutonomousNode,
  type AutonomyMemory,
  type BotDefinition,
  type SearchCitations,
} from "@wakeel/contracts";
import { FakeLlm, makeBotDefinition } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { type AutonomyStepInput, createAutonomy } from "../../src/engine";
import type { AutonomyKnowledge } from "../../src/knowledge/auto-search";
import type { TranscriptMessage } from "../../src/prompt/transcript";
import type { SearchPassage } from "../../src/tools/call-tool";

/**
 * Task 6.12 (ADR-055): the Autonomous Node searches its knowledge tool once per user message,
 * before its first iteration, with a standalone query, and shows the passages as data.
 */

const M = ":::";
const KB = "kb_01m7a256m0a13warwhczsjhx9b";
const TOOL = "tool_SearchCrs0";
const definition = makeBotDefinition({ name: "ماجد" }) as unknown as BotDefinition;

const node = AutonomousNode.parse({
  id: "node_Advisor000",
  type: "autonomous",
  name: "Advisor",
  instructions: "You advise on Engosoft courses.",
  tools: [
    {
      id: TOOL,
      type: "kb_search",
      name: "searchCourses",
      description: "Course pages: prices, schedules, instructors.",
      kbIds: [KB],
      topK: 3,
    },
  ],
  autoSearch: { toolId: TOOL },
  maxIterations: 3,
});

const HVAC: SearchPassage = {
  cite: "[[c1]]",
  title: "hvac.md",
  headingPath: ["دورة التكييف المركزي", "السعر"],
  text: "سعر دورة التكييف المركزي 5,000 جنيه، والتقسيط على 3 شهور.",
};

const turnId = "turn_01m7a256m0a13warwhczsjhx9b";
const message = (text: string) => ({ kind: "message", text });
const inbound = (text: string): TranscriptMessage => ({ direction: "in", payload: { type: "text", text } });
const outbound = (text: string): TranscriptMessage => ({ direction: "out", payload: { type: "text", text } });

interface Options {
  transcript?: TranscriptMessage[];
  replies?: string[];
  passages?: SearchPassage[];
  searchError?: AppError;
  rewrite?: string | AppError;
  noKnowledge?: boolean;
}

function setup(options: Options = {}) {
  const llm = new FakeLlm();
  for (const r of options.replies ?? [`${M}say text\nتمام\n${M}exit listen\n${M}end`]) llm.scriptText(r);
  const searches: { query: string; kbIds: string[]; topK: number; citations?: SearchCitations }[] = [];
  const rewrites: { system: string; content: string }[] = [];
  const knowledge: AutonomyKnowledge = {
    async search(request, citations) {
      searches.push({ ...request, ...(citations ? { citations } : {}) });
      if (options.searchError) throw options.searchError;
      const passages = options.passages ?? [HVAC];
      return {
        passages,
        citations: {
          next: (citations?.next ?? 1) + passages.length,
          sources: Object.fromEntries(
            passages.map((p) => [
              p.cite.slice(2, -2),
              {
                documentId: "doc_01m7a256m0a13warwhczsjhx9b",
                chunkId: "chk_01m7a256m0a13warwhczsjhx9b",
                title: p.title,
                snippet: p.text,
              },
            ]),
          ),
        },
      };
    },
    async rewrite(request) {
      rewrites.push({ system: request.system, content: request.messages.map((m) => m.content).join("\n") });
      if (options.rewrite instanceof AppError) throw options.rewrite;
      return { text: options.rewrite ?? "سعر دورة التكييف المركزي" };
    },
  };
  const autonomy = createAutonomy({
    model: () => ({ stream: (r) => llm.stream({ model: "fake", ...r }) }),
    code: { run: async () => ({ ok: true, returned: true, value: { status: "ok" }, patches: {} }) },
    context: async () => ({
      definition,
      bot: { name: "ماجد" },
      env: {},
      transcript: options.transcript ?? [inbound("بكام دورة التكييف المركزي؟")],
      now: "2026-11-17T10:00:00.000Z",
    }),
    ...(options.noKnowledge ? {} : { knowledge }),
  });
  const input = (extra: Partial<AutonomyStepInput> = {}): AutonomyStepInput => ({
    node,
    location: { workflowId: definition.manifest.mainWorkflowId, nodeId: node.id },
    memory: undefined,
    scopes: { event: message("بكام دورة التكييف المركزي؟"), conversation: {}, user: {}, workflow: {}, turn: {} },
    turnId,
    stepSeq: 1,
    idempotencyKey: `${turnId}:1`,
    deadline: Date.parse("2026-11-17T10:02:00.000Z"),
    ...extra,
  });
  const prompt = (i = -1) => {
    const call = llm.calls.at(i)?.request as { system: string; messages: { content: string }[] };
    return { system: call.system, user: call.messages.map((m) => m.content).join("\n") };
  };
  return { autonomy, input, searches, rewrites, prompt, llm };
}

describe("automatic search", () => {
  test("the first message of a turn is searched once, and the passages reach the model as data", async () => {
    const s = setup();
    const r = await s.autonomy.step(s.input());
    expect(s.searches).toEqual([{ query: "بكام دورة التكييف المركزي؟", kbIds: [KB], topK: 3 }]);
    // The only inbound message has nothing to resolve, so it is searched as written.
    expect(s.rewrites).toEqual([]);
    const { system, user } = s.prompt();
    expect(user).toContain('<data source="knowledge">');
    expect(user).toContain("سعر دورة التكييف المركزي 5,000 جنيه");
    expect(user).toContain('"section":"دورة التكييف المركزي › السعر"');
    // KB text never goes into the system text (CLAUDE.md §9); the rule about it does.
    expect(system).not.toContain("5,000");
    expect(system).toContain("searchCourses");
    expect(r.memory.knowledge).toMatchObject({ turnId, query: "بكام دورة التكييف المركزي؟" });
    expect(r.retrievalCitations?.sources["c1"]).toMatchObject({ title: "hvac.md" });
    expect(r.iteration?.autoSearch).toEqual({ query: "بكام دورة التكييف المركزي؟", returned: 1 });
  });

  test("the passages are cited and the citation survives to the reply", async () => {
    const s = setup({ replies: [`${M}say text\nسعرها 5,000 جنيه [[c1]]\n${M}exit listen\n${M}end`] });
    const r = await s.autonomy.step(s.input());
    expect(r.messages?.[0]).toMatchObject({ type: "text", text: "سعرها 5,000 جنيه [[c1]]" });
    expect(r.retrievalCitations?.sources["c1"]).toBeDefined();
  });

  test("later iterations of the same turn reuse the search instead of searching again", async () => {
    const s = setup({ replies: [`${M}run\nreturn 1\n${M}end`, `${M}say text\nتمام\n${M}exit listen\n${M}end`] });
    const first = await s.autonomy.step(s.input());
    expect(first.outcome).toEqual({ type: "next" });
    await s.autonomy.step(s.input({ memory: first.memory, stepSeq: 2, retrievalCitations: first.retrievalCitations }));
    expect(s.searches).toHaveLength(1);
    expect(s.prompt().user).toContain("سعر دورة التكييف المركزي 5,000 جنيه");
  });

  test("a tool result does not search, and a search from another turn is not shown", async () => {
    const s = setup();
    const memory: AutonomyMemory = {
      iteration: 1,
      memo: {},
      feedback: [],
      knowledge: { turnId: "turn_01m7a256m0a13warwhczsjhx9c", query: "قديم", passages: [] },
    };
    await s.autonomy.step(s.input({ memory, resume: { kind: "tool_result", toolCallId: "x", event: {} } }));
    expect(s.searches).toEqual([]);
    expect(s.prompt().user).not.toContain('<data source="knowledge">');
  });

  test("a turn started by a trigger, not a message, does not search", async () => {
    const s = setup();
    await s.autonomy.step(s.input({ scopes: { event: { kind: "timeout", text: "" }, conversation: {}, user: {} } }));
    expect(s.searches).toEqual([]);
  });

  test("the user's reply after listen starts a new search that replaces the old one", async () => {
    const listen = `${M}say text\nتمام\n${M}exit listen\n${M}end`;
    const s = setup({ replies: [listen, listen] });
    const first = await s.autonomy.step(s.input());
    const reply = message("وفيه تقسيط؟");
    await s.autonomy.step(
      s.input({
        memory: first.memory,
        stepSeq: 2,
        turnId: "turn_01m7a256m0a13warwhczsjhx9d",
        resume: { kind: "message", event: reply },
        scopes: { event: reply, conversation: {}, user: {} },
      }),
    );
    expect(s.searches).toHaveLength(2);
    expect(s.searches[1]?.query).toBe("وفيه تقسيط؟");
  });

  test.each([
    ["Egyptian", "طب وفيه تقسيط؟", "أيوه في دورة التكييف المركزي"],
    ["Gulf", "زين، وكم مدتها؟", "عندنا دورة التكييف المركزي"],
    ["code-switched", "ok طيب الـ schedule بتاعها امتى؟", "HVAC course متاح"],
  ])("a %s follow-up is rewritten with the earlier messages before it is searched", async (_dialect, latest, said) => {
    const s = setup({
      transcript: [inbound("عايز اعرف عن دورة التكييف المركزي"), outbound(said), inbound(latest)],
      rewrite: "  «تقسيط دورة التكييف المركزي»  ",
    });
    const r = await s.autonomy.step(s.input({ scopes: { event: message(latest), conversation: {}, user: {} } }));
    expect(s.rewrites).toHaveLength(1);
    // Earlier messages and the latest one go to the utility model as data, never as its system text.
    expect(s.rewrites[0]?.content).toContain("عايز اعرف عن دورة التكييف المركزي");
    expect(s.rewrites[0]?.content).toContain(said);
    expect(s.rewrites[0]?.content).toContain(latest);
    expect(s.rewrites[0]?.system).not.toContain(latest);
    // Quotes and surrounding space around the model's answer are not part of the query.
    expect(s.searches[0]?.query).toBe("تقسيط دورة التكييف المركزي");
    expect(r.iteration?.autoSearch).toMatchObject({ query: "تقسيط دورة التكييف المركزي", original: latest });
  });

  test("a node that does not rewrite searches the message as written", async () => {
    const s = setup({ transcript: [inbound("عايز اعرف عن دورة التكييف"), outbound("تمام"), inbound("وسعرها؟")] });
    const plain = AutonomousNode.parse({ ...node, autoSearch: { toolId: TOOL, rewrite: false } });
    await s.autonomy.step(s.input({ node: plain, scopes: { event: message("وسعرها؟"), conversation: {}, user: {} } }));
    expect(s.rewrites).toEqual([]);
    expect(s.searches[0]?.query).toBe("وسعرها؟");
  });

  test.each([
    ["fails", new AppError("model_unavailable")],
    ["answers nothing", "   "],
    ["answers at length", "سعر ".repeat(100)],
  ])("when the rewrite %s, the message is searched as written and the step says so", async (_case, rewrite) => {
    const s = setup({
      transcript: [inbound("عايز اعرف عن دورة التكييف"), outbound("تمام"), inbound("وسعرها؟")],
      rewrite,
    });
    const r = await s.autonomy.step(s.input({ scopes: { event: message("وسعرها؟"), conversation: {}, user: {} } }));
    expect(s.searches[0]?.query).toBe("وسعرها؟");
    expect(r.logs?.some((l) => l.level === "warn" && l.message.includes("auto_search_rewrite_failed"))).toBe(true);
  });

  test("a failed search tells the model not to answer from memory, and the turn carries on", async () => {
    const s = setup({ searchError: new AppError("model_unavailable") });
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toMatchObject({ type: "wait" });
    const { user } = s.prompt();
    expect(user).toContain("The knowledge search failed (model_unavailable)");
    expect(user).toContain("Do not answer questions of fact from memory");
    expect(r.memory.knowledge).toMatchObject({ error: "model_unavailable", passages: [] });
    expect(r.iteration?.autoSearch).toMatchObject({ returned: 0, error: "model_unavailable" });
    expect(r.logs?.some((l) => l.level === "warn")).toBe(true);
  });

  test("no passages is said plainly, so the model does not guess", async () => {
    const s = setup({ passages: [] });
    await s.autonomy.step(s.input());
    expect(s.prompt().user).toContain("No passages matched");
  });

  test("a missing knowledge configuration fails the node, as the tool does", async () => {
    const s = setup({ searchError: new AppError("model_not_configured") });
    await expect(s.autonomy.step(s.input())).rejects.toMatchObject({ code: "model_not_configured" });
    const bare = setup({ noKnowledge: true });
    await expect(bare.autonomy.step(bare.input())).rejects.toMatchObject({ code: "model_not_configured" });
  });

  test("running the same step again builds the same prompt", async () => {
    const a = setup({ transcript: [inbound("عايز اعرف عن دورة التكييف"), outbound("تمام"), inbound("وسعرها؟")] });
    const b = setup({ transcript: [inbound("عايز اعرف عن دورة التكييف"), outbound("تمام"), inbound("وسعرها؟")] });
    const event = { scopes: { event: message("وسعرها؟"), conversation: {}, user: {} } };
    await a.autonomy.step(a.input(event));
    await b.autonomy.step(b.input(event));
    expect(a.prompt()).toEqual(b.prompt());
  });

  test("a node without automatic search never searches by itself", async () => {
    const s = setup();
    const { autoSearch: _off, ...rest } = node;
    await s.autonomy.step(s.input({ node: AutonomousNode.parse(rest) }));
    expect(s.searches).toEqual([]);
    expect(s.prompt().user).not.toContain('<data source="knowledge">');
  });
});
