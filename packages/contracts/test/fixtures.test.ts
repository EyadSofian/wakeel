import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  BotDefinition,
  BridgeEvent,
  ConversationState,
  checkWorkflowStructure,
  EvalCase,
  nodePorts,
  RowFilter,
  SendMessageRequest,
  STATE_MAX_BYTES,
} from "../src/index";
import { loadFixture, mutable } from "./load-fixture";

describe("smoke fixtures parse", () => {
  test("bot definition", () => {
    const bot = BotDefinition.parse(loadFixture("bot-definition.json"));
    expect(bot.workflows).toHaveLength(2);
    for (const wf of bot.workflows) expect(checkWorkflowStructure(wf)).toEqual([]);
  });

  test("defaults are applied to the bot definition", () => {
    const bot = BotDefinition.parse(loadFixture("bot-definition.json"));
    const agent = bot.workflows[0]?.nodes.find((n) => n.type === "autonomous");
    expect(agent).toMatchObject({ conversational: true, maxIterations: 6, messageTypes: ["text", "choice"] });
    expect(bot.manifest.settings.limits).toEqual({ turnSeconds: 120, stepsPerTurn: 200 });
  });

  test("nodePorts lists card ports in card order, then next", () => {
    const bot = BotDefinition.parse(loadFixture("bot-definition.json"));
    const welcome = bot.workflows[0]?.nodes.find((n) => n.id === "node_qFcKpkyCk2");
    if (!welcome) throw new Error("fixture changed: welcome node missing");
    expect(nodePorts(welcome)).toEqual([
      "card:card_RFPilKy6x7:failed",
      "card:card_RFPilKy6x7:option:ar",
      "card:card_RFPilKy6x7:option:en",
      "card:card_f7dYpq2Mfs:branch:br_RukGOIaj82",
      "next",
    ]);
  });

  test("bridge events", () => {
    const events = loadFixture("bridge-events.json") as unknown[];
    const types = events.map((e) => BridgeEvent.parse(e).type);
    expect(types).toEqual(["message.created", "handoff.requested", "typing"]);
  });

  test("conversation state", () => {
    const fixture = loadFixture("conversation-state.json");
    const state = ConversationState.parse(fixture);
    expect(state.stack).toHaveLength(2);
    expect(JSON.stringify(fixture).length).toBeLessThan(STATE_MAX_BYTES);
  });

  test("table filter", () => {
    expect(RowFilter.safeParse(loadFixture("table-filter.json")).success).toBe(true);
  });

  test("eval case", () => {
    expect(EvalCase.parse(loadFixture("eval-case.json")).turns).toHaveLength(3);
  });

  test("send message request with Arabic text and user data", () => {
    const req = SendMessageRequest.parse(loadFixture("send-message-request.json"));
    expect(req.message.type).toBe("text");
  });
});

type Case = [name: string, mutate: (doc: ReturnType<typeof mutable>) => unknown];

const rejects = (schema: z.ZodType, fixture: string, cases: Case[]) =>
  test.each(cases)("%s", (_name, mutate) => {
    const doc = mutable(fixture);
    const result = mutate(doc) ?? doc;
    expect(schema.safeParse(result).success).toBe(false);
  });

describe("bot definition rejects", () => {
  const main = (d: ReturnType<typeof mutable>) => d.workflows[0];
  const welcome = (d: ReturnType<typeof mutable>) => main(d).nodes[1];
  const agent = (d: ReturnType<typeof mutable>) => main(d).nodes[2];

  rejects(BotDefinition, "bot-definition.json", [
    [
      "an unknown schema version",
      (d) => {
        d.schemaVersion = 2;
      },
    ],
    [
      "no workflows",
      (d) => {
        d.workflows = [];
      },
    ],
    [
      "a workflow id that is not a nanoid",
      (d) => {
        main(d).id = "wf_main";
      },
    ],
    [
      "an entity id used as an element id",
      (d) => {
        main(d).id = "wf_01m7a256m03ekr5s35pwdea14m";
      },
    ],
    [
      "an unknown card type",
      (d) => {
        welcome(d).cards[0].type = "send_email";
      },
    ],
    [
      "an empty text message",
      (d) => {
        welcome(d).cards[0].message.text = "";
      },
    ],
    [
      "an unknown capture kind",
      (d) => {
        welcome(d).cards[1].kind = "voice";
      },
    ],
    [
      "a choice prompt with no options",
      (d) => {
        welcome(d).cards[1].prompt.options = [];
      },
    ],
    [
      "an enum variable with no allowed values",
      (d) => {
        d.manifest.variables[0].enumValues = undefined;
      },
    ],
    [
      "a variable name that is not an identifier",
      (d) => {
        d.manifest.variables[1].name = "order id";
      },
    ],
    [
      "a config key in lower case",
      (d) => {
        d.manifest.configVars[0].key = "orders_token";
      },
    ],
    [
      "a model ref without a provider",
      (d) => {
        d.manifest.settings.models.default = "claude";
      },
    ],
    [
      "a malformed port id",
      (d) => {
        main(d).edges[0].from.port = "exit:done";
      },
    ],
    [
      "max iterations above the limit",
      (d) => {
        agent(d).maxIterations = 21;
      },
    ],
    [
      "a tool with no description",
      (d) => {
        agent(d).tools[0].description = "";
      },
    ],
    [
      "a variable access mode that does not exist",
      (d) => {
        agent(d).variableAccess[0].mode = "admin";
      },
    ],
    [
      "a coalesce window above 5 seconds",
      (d) => {
        d.manifest.settings.coalesceWindowMs = 6000;
      },
    ],
    [
      "a bad locale",
      (d) => {
        d.manifest.defaultLocale = "arabic";
      },
    ],
  ]);
});

describe("workflow structure catches", () => {
  const parsedMain = () => {
    const bot = BotDefinition.parse(loadFixture("bot-definition.json"));
    const wf = bot.workflows[0];
    if (!wf) throw new Error("fixture changed: main workflow missing");
    return wf;
  };

  type Wf = ReturnType<typeof parsedMain>;
  const cases: [code: string, mutate: (wf: Wf) => void][] = [
    ["start_node_count", (wf) => wf.nodes.push({ ...wf.nodes[0], id: "node_SecondStrt" } as Wf["nodes"][number])],
    [
      "edge_target_invalid",
      (wf) => {
        const edge = wf.edges[0];
        if (edge) edge.to.nodeId = "node_lRoBm4x7yq";
      },
    ],
    ["edge_duplicate", (wf) => wf.edges.push({ ...wf.edges[0], id: "edge_Duplicate1" } as Wf["edges"][number])],
    ["exit_unconnected", (wf) => wf.edges.splice(2, 1)],
    [
      "edge_port_missing",
      (wf) => {
        const edge = wf.edges[4];
        if (edge) edge.from.port = "card:card_RFPilKy6x7:option:fr";
      },
    ],
  ];

  test.each(cases)("%s", (code, mutate) => {
    const wf = parsedMain();
    mutate(wf);
    expect(checkWorkflowStructure(wf).map((i) => i.code)).toContain(code);
  });
});

describe("bridge event rejects", () => {
  rejects(BridgeEvent, "bridge-events.json", [
    ["a different API version", (d) => ({ ...d[0], apiVersion: "2025-01-01" })],
    ["seq 0", (d) => ({ ...d[0], seq: 0 })],
    ["an unknown event type", (d) => ({ ...d[0], type: "message.deleted" })],
    [
      "a user postback sent as a bot message",
      (d) => {
        d[0].data.message.payload = { type: "postback", value: "ar" };
        return d[0];
      },
    ],
    ["a timestamp without an offset", (d) => ({ ...d[0], createdAt: "2026-11-13T09:00:01" })],
    ["an unknown typing state", (d) => ({ ...d[2], data: { state: "maybe" } })],
    [
      "a citation index of 0",
      (d) => {
        d[0].data.message.citations[0].index = 0;
        return d[0];
      },
    ],
  ]);
});

describe("conversation state rejects", () => {
  rejects(ConversationState, "conversation-state.json", [
    [
      "an unknown state version",
      (d) => {
        d.v = 2;
      },
    ],
    [
      "an unknown status",
      (d) => {
        d.status = "sleeping";
      },
    ],
    [
      "a stack deeper than 16",
      (d) => {
        d.stack = Array.from({ length: 17 }, () => d.stack[0]);
      },
    ],
    [
      "an unknown wait kind",
      (d) => {
        d.wait.kind = "sleep";
      },
    ],
    [
      "a negative card index",
      (d) => {
        d.stack[0].cardIndex = -1;
      },
    ],
    [
      "unknown autonomy feedback",
      (d) => {
        d.autonomy["wf_e3EcDF6eqB:node_E9LhcsG1bp"].feedback[0].kind = "hint";
      },
    ],
  ]);
});

describe("table filter rejects", () => {
  rejects(RowFilter, "table-filter.json", [
    ["two operators in one condition", () => ({ status: { eq: "a", ne: "b" } })],
    ["no operator in a condition", () => ({ status: {} })],
    ["an empty and", () => ({ and: [] })],
    ["extra keys next to and", () => ({ and: [{ a: { eq: 1 } }], or: [] })],
    ["a column name that is not an identifier", () => ({ "1total": { gt: 5 } })],
    ["an unknown operator", () => ({ status: { like: "%a%" } })],
    ["more than 200 values in in", () => ({ status: { in: Array.from({ length: 201 }, (_, i) => i) } })],
  ]);
});

describe("eval case rejects", () => {
  rejects(EvalCase, "eval-case.json", [
    [
      "a turn with both user text and a postback",
      (d) => {
        d.turns[0].postback = "ar";
      },
    ],
    [
      "a turn with no input",
      (d) => {
        d.turns[1] = { assert: [] };
      },
    ],
    [
      "no turns",
      (d) => {
        d.turns = [];
      },
    ],
    [
      "an unknown assertion",
      (d) => {
        d.turns[0].assert.push({ type: "sentiment", value: "positive" });
      },
    ],
    [
      "a tag longer than 32 characters",
      (d) => {
        d.tags.push("x".repeat(33));
      },
    ],
  ]);
});

describe("send message request rejects", () => {
  rejects(SendMessageRequest, "send-message-request.json", [
    [
      "an invalid email",
      (d) => {
        d.user.email = "mona at example";
      },
    ],
    [
      "a bot-only message type",
      (d) => {
        d.message = { type: "choice", text: "x", options: [{ label: "a", value: "a" }] };
      },
    ],
    [
      "user text over 16 000 characters",
      (d) => {
        d.message.text = "ع".repeat(16_001);
      },
    ],
    [
      "an empty user id",
      (d) => {
        d.userId = "";
      },
    ],
  ]);
});
