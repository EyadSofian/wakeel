import { describe, expect, test } from "vitest";
import { FakeClock, FakeLlm, FakeLlmError } from "../src/index";

/** Collects chunks with the clock time each one arrived at. */
async function collect(stream: AsyncIterable<string>, clock?: FakeClock) {
  const out: { text: string; at: number }[] = [];
  for await (const text of stream) out.push({ text, at: clock?.now() ?? 0 });
  return out;
}

describe("scripted streams", () => {
  test("yield chunks at the times the script sets, under test control (acceptance 0.6)", async () => {
    const clock = new FakeClock(0);
    const llm = new FakeLlm({ clock });
    llm.scriptStream([
      { text: "مرحبا", delayMs: 300 },
      { text: " بك", delayMs: 50 },
      { text: "!", delayMs: 1000 },
    ]);
    const handle = llm.stream({ model: "fake:model" });
    const received = collect(handle.textStream, clock);

    await clock.advance(299);
    const early = await Promise.race([received.then(() => "done"), Promise.resolve("waiting")]);
    expect(early).toBe("waiting");

    await clock.runAll();
    expect(await received).toEqual([
      { text: "مرحبا", at: 300 },
      { text: " بك", at: 350 },
      { text: "!", at: 1350 },
    ]);
    const result = await handle.result;
    expect(result).toMatchObject({ text: "مرحبا بك!", finishReason: "stop", ttftMs: 300 });
  });

  test("nothing arrives before its delay has passed", async () => {
    const clock = new FakeClock(0);
    const llm = new FakeLlm({ clock }).scriptStream([
      { text: "a", delayMs: 100 },
      { text: "b", delayMs: 100 },
    ]);
    const seen: string[] = [];
    const done = (async () => {
      for await (const t of llm.stream({ model: "m" }).textStream) seen.push(t);
    })();
    await clock.advance(99);
    expect(seen).toEqual([]);
    await clock.advance(1);
    expect(seen).toEqual(["a"]);
    await clock.advance(100);
    await done;
    expect(seen).toEqual(["a", "b"]);
  });

  test("without delays, chunks arrive at once and need no clock", async () => {
    const llm = new FakeLlm().scriptStream(["one ", "two"]);
    expect((await collect(llm.stream({ model: "m" }).textStream)).map((c) => c.text)).toEqual(["one ", "two"]);
  });

  test("scriptText splits by code point and keeps Arabic intact", async () => {
    const llm = new FakeLlm().scriptText(":::say text\nأهلاً 🎉\n:::end", { chunkSize: 3 });
    const chunks = (await collect(llm.stream({ model: "m" }).textStream)).map((c) => c.text);
    expect(chunks.join("")).toBe(":::say text\nأهلاً 🎉\n:::end");
    expect(chunks[0]).toBe(":::");
  });

  test("stops at a stop sequence, even one split across chunks, and leaves it out", async () => {
    const llm = new FakeLlm().scriptStream([":::say text\nتمام", "\n::", ":end\nignored"]);
    const handle = llm.stream({ model: "m", stop: [":::end"] });
    const text = (await collect(handle.textStream)).map((c) => c.text).join("");
    expect(text).toBe(":::say text\nتمام\n");
    expect((await handle.result).finishReason).toBe("stop");
  });

  test("a scripted error arrives after the given chunks, for retry and fallback tests", async () => {
    const llm = new FakeLlm().scriptStreamError(new FakeLlmError("rate limited", 429), ["partial "]);
    const handle = llm.stream({ model: "m" });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const t of handle.textStream) seen.push(t);
      })(),
    ).rejects.toMatchObject({ status: 429 });
    expect(seen).toEqual(["partial "]);
    await expect(handle.result).rejects.toBeInstanceOf(FakeLlmError);
  });

  test("an abort stops a stream waiting on the clock", async () => {
    const clock = new FakeClock(0);
    const llm = new FakeLlm({ clock }).scriptStream([{ text: "late", delayMs: 5000 }]);
    const controller = new AbortController();
    const consumed = collect(llm.stream({ model: "m", signal: controller.signal }).textStream, clock);
    await clock.advance(10);
    controller.abort();
    await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
  });

  test("records every call and reports unused or missing scripts", async () => {
    const llm = new FakeLlm().scriptStream(["x"]).scriptStream(["y"]);
    await collect(llm.stream({ model: "m", purpose: "autonomy" }).textStream);
    expect(llm.calls).toEqual([{ op: "stream", request: { model: "m", purpose: "autonomy" } }]);
    expect(() => llm.expectDone()).toThrow(/1 scripted response/);
    await collect(llm.stream({ model: "m" }).textStream);
    await expect(collect(llm.stream({ model: "m", purpose: "judge" }).textStream)).rejects.toThrow(
      /no scripted stream left.*judge/,
    );
  });

  test("usage defaults to an output estimate and accepts scripted numbers", async () => {
    const llm = new FakeLlm().scriptStream(["12345678"], { usage: { inputTokens: 3000, cachedInputTokens: 2500 } });
    const handle = llm.stream({ model: "m" });
    await collect(handle.textStream);
    expect((await handle.result).usage).toEqual({ inputTokens: 3000, cachedInputTokens: 2500, outputTokens: 2 });
  });
});

describe("other operations", () => {
  test("generateObject returns scripted values in order, or the scripted error", async () => {
    const llm = new FakeLlm().scriptObject({ city: "القاهرة" }).scriptObjectError(new FakeLlmError("bad", 400));
    expect((await llm.generateObject({ model: "m" })).object).toEqual({ city: "القاهرة" });
    await expect(llm.generateObject({ model: "m" })).rejects.toMatchObject({ status: 400 });
  });

  test("embed is deterministic, unit length and 1024-dimensional by default", async () => {
    const llm = new FakeLlm();
    const { embeddings } = await llm.embed({ model: "m", values: ["سياسة الشحن", "سياسة الشحن", "return policy"] });
    const [a, b, c] = embeddings;
    expect(a).toHaveLength(1024);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(Math.hypot(...(a ?? []))).toBeCloseTo(1, 10);
  });

  test("rerank orders documents by shared words, Arabic included", async () => {
    const llm = new FakeLlm();
    const { ranking } = await llm.rerank({
      model: "m",
      query: "مدة الشحن للقاهرة",
      documents: ["سياسة الاسترجاع", "مدة الشحن داخل القاهرة يومين", "الشحن الدولي"],
    });
    expect(ranking[0]?.index).toBe(1);
    expect(ranking.at(-1)?.index).toBe(0);
  });
});
