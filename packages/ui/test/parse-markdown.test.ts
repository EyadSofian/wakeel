import { RTL_FIXTURES } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { type MdBlock, type MdInline, parseMarkdown } from "../src/conversation/parse-markdown";
import { motionTokens, typing } from "../src/motion";

/**
 * Bot text is markdown (message.ts `format`). It is parsed into a small tree and rendered as React
 * elements; nothing is ever passed to dangerouslySetInnerHTML (CLAUDE.md §6), so markup in the text
 * stays text.
 */
describe("parseMarkdown", () => {
  test("paragraphs, line breaks, bold, italic and code", () => {
    expect(parseMarkdown("أهلاً **منى**،\nطلبك `ORD-1` *اتشحن*.\n\nسطر تاني")).toEqual([
      {
        t: "p",
        c: [
          { t: "text", v: "أهلاً " },
          { t: "strong", c: [{ t: "text", v: "منى" }] },
          { t: "text", v: "،" },
          { t: "br" },
          { t: "text", v: "طلبك " },
          { t: "code", v: "ORD-1" },
          { t: "text", v: " " },
          { t: "em", c: [{ t: "text", v: "اتشحن" }] },
          { t: "text", v: "." },
        ],
      },
      { t: "p", c: [{ t: "text", v: "سطر تاني" }] },
    ]);
  });

  test("lists, bulleted and numbered", () => {
    expect(parseMarkdown("- واحد\n- two\n\n1. أول\n2. second")).toEqual([
      { t: "ul", items: [[{ t: "text", v: "واحد" }], [{ t: "text", v: "two" }]] },
      { t: "ol", items: [[{ t: "text", v: "أول" }], [{ t: "text", v: "second" }]] },
    ]);
  });

  test("links only for http, https, mailto and tel; bare URLs become links", () => {
    expect(
      parseMarkdown("[تتبع](https://track.example.com/1) [x](javascript:alert(1)) https://a.example/b?lang=ar"),
    ).toEqual([
      {
        t: "p",
        c: [
          { t: "link", href: "https://track.example.com/1", c: [{ t: "text", v: "تتبع" }] },
          { t: "text", v: " [x](javascript:alert(1)) " },
          { t: "link", href: "https://a.example/b?lang=ar", c: [{ t: "text", v: "https://a.example/b?lang=ar" }] },
        ],
      },
    ]);
  });

  test("HTML stays text", () => {
    expect(parseMarkdown('<img src=x onerror="alert(1)"> مرحبا')).toEqual([
      { t: "p", c: [{ t: "text", v: '<img src=x onerror="alert(1)"> مرحبا' }] },
    ]);
  });

  test("an unclosed marker is kept as text", () => {
    expect(parseMarkdown("سعر **خاص")).toEqual([{ t: "p", c: [{ t: "text", v: "سعر **خاص" }] }]);
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f.text] as const))("RTL fixture %s keeps every character", (_id, text) => {
    const inline = (nodes: readonly MdInline[]): string =>
      nodes.map((n) => ("v" in n ? n.v : "c" in n ? inline(n.c) : "\n")).join("");
    const flat = (blocks: readonly MdBlock[]) =>
      blocks.map((b) => (b.t === "p" ? inline(b.c) : b.items.map(inline).join(""))).join("");
    expect(flat(parseMarkdown(text))).toBe(text);
  });
});

describe("typing motion tokens (§5.3)", () => {
  test("three dots loop every 1.2 s after 300 ms; static when motion is reduced", () => {
    expect(typing).toEqual({ loop: 1.2, appearAfter: 0.3 });
    expect(motionTokens(false).typing).toEqual({ loop: 1.2, appearAfter: 0.3 });
    expect(motionTokens(true).typing).toEqual({ loop: null, appearAfter: 0.3 });
  });
});
