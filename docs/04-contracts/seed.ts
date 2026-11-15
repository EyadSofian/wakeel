import { type BotManifest, SCHEMA_VERSION } from "./bot-definition";
import { newElementId } from "./ids";
import type { Workflow } from "./workflow";

/**
 * What a new bot starts with (task 2.1): a manifest and a Main workflow holding a Start node wired
 * to one Autonomous node. Pure, so the api and tests build the same thing.
 */

/**
 * Model defaults until the model registry and workspace defaults exist (6.1, 6.2). They are only
 * starting values in the manifest; a builder changes them in bot settings.
 */
export const DEFAULT_MODELS = {
  default: "anthropic:claude-sonnet-5-5",
  utility: "anthropic:claude-haiku-5-5",
} as const;

/** Canvas spacing for seeded nodes: node width 280 plus an 80 px gap (design system §2.3). */
const COLUMN = 360;

export interface SeededBot {
  schemaVersion: typeof SCHEMA_VERSION;
  manifest: BotManifest;
  main: Workflow;
}

export function seedBot(input: { name: string; defaultLocale?: string }): SeededBot {
  const mainId = newElementId("wf");
  const startId = newElementId("node");
  const agentId = newElementId("node");
  const defaultLocale = input.defaultLocale ?? "ar";
  const manifest: BotManifest = {
    name: input.name,
    defaultLocale,
    locales: defaultLocale === "en" ? ["en", "ar"] : [defaultLocale, "en"].filter((l, i, a) => a.indexOf(l) === i),
    settings: {
      models: { ...DEFAULT_MODELS },
      inactivityTimeoutMinutes: 1_440,
      errorMessage: "Something went wrong on our side. Please try again in a moment.",
      quotaMessage: "This assistant is temporarily unavailable.",
      coalesceWindowMs: 0,
      transcriptTokenBudget: 6_000,
      limits: { turnSeconds: 120, stepsPerTurn: 200 },
    },
    variables: [],
    configVars: [],
    mainWorkflowId: mainId,
  };
  const main: Workflow = {
    id: mainId,
    name: "Main",
    kind: "main",
    inputs: [],
    outputs: [],
    variables: [],
    nodes: [
      { id: startId, name: "Start", type: "start" },
      {
        id: agentId,
        name: "Assistant",
        type: "autonomous",
        // Left empty on purpose: validation (2.2) asks the builder to write them.
        instructions: "",
        tools: [],
        variableAccess: [],
        exits: [],
        conversational: true,
        allowHandoff: false,
        maxIterations: 6,
        temperature: 0.3,
        messageTypes: ["text", "choice"],
      },
    ],
    edges: [{ id: newElementId("edge"), from: { nodeId: startId, port: "next" }, to: { nodeId: agentId } }],
    layout: { [startId]: { x: 0, y: 0 }, [agentId]: { x: COLUMN, y: 0 } },
  };
  return { schemaVersion: SCHEMA_VERSION, manifest, main };
}

/** A new sub-workflow: Entry wired to one Exit. Used by the workflows panel (2.8). */
export function seedSubWorkflow(name: string): Workflow {
  const entry = newElementId("node");
  const exit = newElementId("node");
  return {
    id: newElementId("wf"),
    name,
    kind: "sub",
    inputs: [],
    outputs: [],
    variables: [],
    nodes: [
      { id: entry, name: "Entry", type: "entry" },
      { id: exit, name: "Exit", type: "exit", outputs: {} },
    ],
    edges: [{ id: newElementId("edge"), from: { nodeId: entry, port: "next" }, to: { nodeId: exit } }],
    layout: { [entry]: { x: 0, y: 0 }, [exit]: { x: COLUMN, y: 0 } },
  };
}
