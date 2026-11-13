import {
  BotDefinition,
  BridgeEvent,
  ConversationState,
  checkWorkflowStructure,
  Message,
  SendMessageRequest,
} from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  chunkText,
  everySplit,
  FakeClock,
  firstStrongDirection,
  LANGUAGE_FIXTURES,
  makeBotDefinition,
  makeConversationState,
  makeMessage,
  makeMessageCreatedEvent,
  makeSendMessageRequest,
  RTL_FIXTURES,
  SCREENSHOT_FIXTURES,
  splitAt,
} from "../src/index";

describe("FakeClock", () => {
  test("starts at a fixed time and only moves when told", async () => {
    const clock = new FakeClock();
    expect(clock.iso()).toBe("2026-11-13T09:00:00.000Z");
    await clock.advance(1500);
    expect(clock.iso()).toBe("2026-11-13T09:00:01.500Z");
  });

  test("fires timers in time order, then insertion order", async () => {
    const clock = new FakeClock(0);
    const order: string[] = [];
    clock.setTimeout(() => order.push("b@20"), 20);
    clock.setTimeout(() => order.push("a@10"), 10);
    clock.setTimeout(() => order.push("c@20"), 20);
    await clock.advance(20);
    expect(order).toEqual(["a@10", "b@20", "c@20"]);
  });

  test("chained sleeps resolve within one advance, at the right times", async () => {
    const clock = new FakeClock(0);
    const times: number[] = [];
    const loop = (async () => {
      for (let i = 0; i < 3; i++) {
        await clock.sleep(100);
        times.push(clock.now());
      }
    })();
    await clock.advance(1000);
    await loop;
    expect(times).toEqual([100, 200, 300]);
    expect(clock.now()).toBe(1000);
  });

  test("clearTimeout cancels and abort rejects a sleep", async () => {
    const clock = new FakeClock(0);
    let fired = false;
    clock.clearTimeout(clock.setTimeout(() => (fired = true), 5));
    const controller = new AbortController();
    const sleeping = clock.sleep(50, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toMatchObject({ name: "AbortError" });
    await clock.runAll();
    expect(fired).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test("runAll stops a timer that reschedules forever", async () => {
    const clock = new FakeClock(0);
    const tick = () => clock.setTimeout(tick, 1);
    tick();
    await expect(clock.runAll(50)).rejects.toThrow(/more than 50 timers/);
  });

  test.each([-1, Number.NaN])("rejects a delay of %s", (ms) => {
    expect(() => new FakeClock(0).setTimeout(() => undefined, ms)).toThrow(RangeError);
  });
});

describe("factories build valid contract objects", () => {
  test("bot definition", () => {
    const bot = makeBotDefinition();
    expect(BotDefinition.safeParse(bot).success).toBe(true);
    for (const wf of bot.workflows) expect(checkWorkflowStructure(wf)).toEqual([]);
  });

  test("two bots never share ids", () => {
    expect(makeBotDefinition().manifest.mainWorkflowId).not.toBe(makeBotDefinition().manifest.mainWorkflowId);
  });

  test("message, event, state and request", () => {
    expect(Message.safeParse(makeMessage({ seq: 3 })).success).toBe(true);
    expect(BridgeEvent.safeParse(makeMessageCreatedEvent({ text: "طلبك وصل" })).success).toBe(true);
    expect(ConversationState.parse(makeConversationState({ status: "waiting_input" })).status).toBe("waiting_input");
    expect(SendMessageRequest.safeParse(makeSendMessageRequest()).success).toBe(true);
  });

  test("invalid overrides are rejected, not passed through", () => {
    expect(() => makeMessage({ seq: -1 })).toThrow();
    expect(() => makeSendMessageRequest("")).toThrow();
  });
});

describe("RTL fixtures", () => {
  test("cover the seven cases design system §6 requires", () => {
    expect(SCREENSHOT_FIXTURES.map((f) => f.id)).toEqual([
      "pure_arabic",
      "arabic_product_code",
      "english_arabic_name",
      "arabic_url",
      "long_token",
      "arabic_diacritics",
      "emoji",
    ]);
  });

  test("cover the dialects and code-switching CLAUDE.md §11 requires", () => {
    expect(LANGUAGE_FIXTURES.map((f) => f.id)).toEqual(
      expect.arrayContaining(["egyptian", "gulf", "code_switch", "arabic_indic_digits"]),
    );
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f] as const))("%s resolves to its stated direction", (_id, fixture) => {
    expect(firstStrongDirection(fixture.text)).toBe(fixture.direction);
  });

  test("each fixture has the property it is named for", () => {
    const byId = Object.fromEntries(RTL_FIXTURES.map((f) => [f.id, f.text]));
    expect(byId["arabic_diacritics"]).toMatch(/[ً-ْ]/);
    expect(byId["emoji"]).toMatch(/\p{Extended_Pictographic}/u);
    expect(byId["arabic_url"]).toMatch(/https:\/\/\S+/);
    expect(byId["long_token"]).toMatch(/\S{100,}/);
    expect(byId["english_arabic_name"]).toMatch(/\p{Script=Arabic}/u);
    expect(byId["arabic_indic_digits"]).toMatch(/[٠-٩]/);
    expect(byId["code_switch"]).toMatch(/[a-z]{4,}/);
  });

  test("ids are unique", () => {
    expect(new Set(RTL_FIXTURES.map((f) => f.id)).size).toBe(RTL_FIXTURES.length);
  });

  test("neutral-only text falls back to ltr", () => {
    expect(firstStrongDirection("12345 — !?")).toBe("ltr");
  });
});

describe("text splitting", () => {
  test("chunkText keeps emoji whole", () => {
    expect(chunkText("أ🎉ب", 1)).toEqual(["أ", "🎉", "ب"]);
  });

  test("splitAt cuts at code-point offsets", () => {
    expect(splitAt(":::say", [3])).toEqual([":::", "say"]);
  });

  test("everySplit gives each two-chunk cut", () => {
    expect(everySplit("abc")).toEqual([
      ["a", "bc"],
      ["ab", "c"],
    ]);
  });
});
