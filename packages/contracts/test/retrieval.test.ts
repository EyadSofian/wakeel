import { describe, expect, test } from "vitest";
import {
  KbSettings,
  mapCitations,
  mapPayloadCitations,
  newId,
  SearchCitations,
  SearchRequest,
  SearchTrace,
} from "../src/index";

const source = { documentId: newId("doc"), chunkId: newId("chk"), title: "سياسة ORD-12" };
const sources = { c1: source, c2: { ...source, documentId: newId("doc") } };

describe("retrieval contracts (ADR-043)", () => {
  test("parses Arabic filters and rejects unsupported filters and nonfinite floors", () => {
    expect(
      SearchRequest.parse({ query: "  وين ORD-12؟  ", kbIds: [newId("kb")], filters: { languages: ["ar"] } }),
    ).toMatchObject({ query: "وين ORD-12؟", topK: 5 });
    expect(
      SearchRequest.safeParse({ query: "بحث", kbIds: [newId("kb")], filters: { tenantId: newId("ws") } }).success,
    ).toBe(false);
    expect(SearchRequest.safeParse({ query: "بحث", kbIds: [], topK: 0 }).success).toBe(false);
    expect(KbSettings.safeParse({ minScore: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(KbSettings.parse({ minScore: -7 })).toEqual({ minScore: -7 });
    expect(SearchCitations.parse({})).toEqual({ next: 1, sources: {} });
    expect(SearchTrace.safeParse({ dense: [{ chunkId: "foreign", score: 1 }] }).success).toBe(false);
  });
  test("only registered sources survive, numbered in first-use order, including mixed directions", () => {
    expect(mapCitations("وصل ORD-12 [[c2]] خلال ١٤ يومًا [[c1]] [[c2]] [[c999]]", sources)).toEqual({
      text: "وصل ORD-12 خلال ١٤ يومًا",
      citations: [
        { ...sources.c2, index: 1 },
        { ...source, index: 2 },
      ],
    });
  });
  test("text, interactive prompts and image captions use the same citation boundary", () => {
    const result = mapPayloadCitations({ type: "text", text: "سياسة [[c1]]", format: "plain" }, sources);
    expect(result).toMatchObject({
      payload: { text: "سياسة" },
      citations: [{ index: 1, documentId: source.documentId }],
    });
    expect(
      mapPayloadCitations({ type: "image", url: "https://example.test/image.png", caption: "شرح [[c2]]" }, sources),
    ).toMatchObject({ payload: { caption: "شرح" }, citations: [{ documentId: sources.c2.documentId }] });
    expect(
      mapPayloadCitations({ type: "file", name: "سياسة.pdf", url: "https://example.test/policy.pdf" }, sources)
        .citations,
    ).toEqual([]);
  });
});
