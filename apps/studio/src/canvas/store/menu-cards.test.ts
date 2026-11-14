import { Card, checkJsonSchema, newElementId, Variable } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { createMenuCard, type MenuCardType } from "./factories";
import { seededDraft } from "./fixtures.test-utils";

/** Every card the add-card menu can make is schema-valid as made, so adding it never autosaves an invalid draft. */
describe("card menu factories", () => {
  const { main } = seededDraft();
  const types: MenuCardType[] = [
    "say",
    "capture",
    "branch",
    "ai_branch",
    "ai_generate",
    "ai_extract",
    "set_variable",
    "code",
    "call_workflow",
    "handoff",
    "end",
    "log",
  ];

  test.each(types)("%s is a valid card", (type) => {
    const sub = { ...main, id: newElementId("wf"), kind: "sub" as const };
    const made = createMenuCard(type, main, [main, sub]);
    if (!("card" in made)) throw new Error(made.unavailable);
    expect(Card.safeParse(made.card).success).toBe(true);
    if (made.variable) expect(Variable.safeParse(made.variable).success).toBe(true);
  });

  test("Generate text writes to a new text variable", () => {
    const made = createMenuCard("ai_generate", main, [main]);
    if (!("card" in made) || made.card.type !== "ai_generate") throw new Error("expected Generate text");
    expect(made.variable?.type).toBe("string");
    expect(made.card.into).toBe(made.variable?.id);
  });

  test("Extract data writes to a new object variable with a supported schema", () => {
    const made = createMenuCard("ai_extract", main, [main]);
    if (!("card" in made) || made.card.type !== "ai_extract") throw new Error("expected Extract data");
    expect(made.variable?.type).toBe("object");
    expect(checkJsonSchema(made.card.schema)).toEqual([]);
  });

  test("AI condition starts with two options with distinct ids", () => {
    const made = createMenuCard("ai_branch", main, [main]);
    if (!("card" in made) || made.card.type !== "ai_branch") throw new Error("expected AI condition");
    expect(new Set(made.card.branches.map((b) => b.id)).size).toBe(2);
  });
});
