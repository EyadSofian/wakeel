import { type Card, cardPortKeys, type Node, nodePorts, seedBot, type Variable } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { createCard, createNode } from "../store/factories";
import { CARD_ICONS, CARD_NAMES, cardOutputRows, nodeOutputRows, summarizeCard } from "./summaries";

const email: Variable = { id: "var_AAAAAAAAAA", name: "email", scope: "user", type: "string", sensitive: false };
const ctx = {
  variables: new Map([[email.id, email]]),
  workflows: new Map([["wf_BBBBBBBBBB", { name: "استرجاع الطلب" }]]),
};

describe("card summaries", () => {
  test.each<[string, Card, string]>([
    [
      "text message, first line",
      {
        ...createCard("say"),
        message: { type: "text", text: "\nأهلاً {{user.name}}\nكيف أساعدك؟", format: "markdown" },
      } as Card,
      "أهلاً {{user.name}}",
    ],
    ["label wins", { ...createCard("say"), label: "Welcome" } as Card, "Welcome"],
    [
      "ask with choice",
      {
        id: "card_AAAAAAAAAA",
        type: "capture",
        disabled: false,
        kind: "choice",
        into: email.id,
        maxRetries: 2,
        skipIfFilled: false,
        routeByOption: true,
        prompt: { type: "choice", text: "Choose language", options: [{ label: "العربية", value: "ar" }] },
      },
      "Choose language",
    ],
    [
      "set variable names the variable",
      {
        id: "card_AAAAAAAAAA",
        type: "set_variable",
        disabled: false,
        assignments: [{ variableId: email.id, value: "'x'" }],
      },
      "user.email",
    ],
    [
      "a missing variable says so",
      {
        id: "card_AAAAAAAAAA",
        type: "set_variable",
        disabled: false,
        assignments: [{ variableId: "var_ZZZZZZZZZZ", value: "1" }],
      },
      "a missing variable",
    ],
    [
      "run workflow names it",
      {
        id: "card_AAAAAAAAAA",
        type: "call_workflow",
        disabled: false,
        workflowId: "wf_BBBBBBBBBB",
        inputs: {},
        outputs: {},
      },
      "استرجاع الطلب",
    ],
    ["empty code", createCard("code"), "Empty code"],
    ["set timeout zero", { ...createCard("set_timeout"), minutes: 0 } as Card, "Never expire"],
  ])("%s", (_name, card, text) => {
    expect(summarizeCard(card, ctx)).toBe(text);
  });

  test("every card type has a name from design system §3.1 and an icon", () => {
    expect(Object.keys(CARD_NAMES).sort()).toEqual(Object.keys(CARD_ICONS).sort());
    expect(CARD_NAMES.handoff).toBe("Hand off to a person");
    expect(CARD_NAMES.capture).toBe("Ask");
  });
});

describe("output rows match the contract's ports", () => {
  test.each<[string, Node]>([
    [
      "seeded autonomous node",
      (() => {
        const n = createNode("autonomous") as Extract<Node, { type: "autonomous" }>;
        n.exits = [{ id: "exit_AAAAAAAAAA", name: "resolved", description: "Done" }];
        return n;
      })(),
    ],
    [
      "standard node with cards",
      (() => {
        const n = createNode("standard") as Extract<Node, { type: "standard" }>;
        n.cards = [createCard("branch"), createCard("code"), createCard("say")];
        return n;
      })(),
    ],
    [
      "standard node ending in End",
      (() => {
        const n = createNode("standard") as Extract<Node, { type: "standard" }>;
        n.cards = [createCard("say"), createCard("end")];
        return n;
      })(),
    ],
    ["start", seedBot({ name: "x" }).main.nodes[0] as Node],
    ["end", createNode("end")],
  ])("%s", (_name, node) => {
    const rows = [...(node.type === "standard" ? node.cards.flatMap(cardOutputRows) : []), ...nodeOutputRows(node)];
    expect(rows.map((r) => r.port).sort()).toEqual(nodePorts(node).sort());
  });

  test("card rows list exactly the card's ports", () => {
    for (const type of ["branch", "code", "say", "end", "log"] as const) {
      const card = createCard(type);
      expect(cardOutputRows(card).map((r) => r.port)).toEqual(cardPortKeys(card).map((k) => `card:${card.id}:${k}`));
    }
  });
});
