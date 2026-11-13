import { z } from "zod";
import { DisplayName, Locale, ModelRef, Template, WorkflowId } from "./common";
import { ConfigVar, Variable } from "./variable";
import { Workflow } from "./workflow";

export const SCHEMA_VERSION = 1 as const;

export const BotSettings = z.object({
  models: z.object({
    /** Used by Autonomous Nodes and AI cards unless overridden. */
    default: ModelRef,
    /** Cheap model for summaries, extraction, classification, judging. */
    utility: ModelRef,
  }),
  /** 0 = conversations never expire. */
  inactivityTimeoutMinutes: z.number().int().min(0).max(43_200).default(1_440),
  /** Sent when a turn fails and nothing handles the error. */
  errorMessage: Template.default("Something went wrong on our side. Please try again in a moment."),
  /** Sent when the workspace has reached a hard usage cap. */
  quotaMessage: Template.default("This assistant is temporarily unavailable."),
  /** Merge text messages that arrive within this window into one turn. 0 = off. */
  coalesceWindowMs: z.number().int().min(0).max(5_000).default(0),
  /** Transcript tokens given to models before older messages are summarised. */
  transcriptTokenBudget: z.number().int().min(1_000).max(60_000).default(6_000),
  /** Per-turn ceilings; lower than the platform limits in packages/config. */
  limits: z
    .object({
      turnSeconds: z.number().int().min(5).max(300).default(120),
      stepsPerTurn: z.number().int().min(10).max(200).default(200),
    })
    .default({ turnSeconds: 120, stepsPerTurn: 200 }),
});
export type BotSettings = z.infer<typeof BotSettings>;

export const BotManifest = z.object({
  name: DisplayName,
  description: z.string().max(1_000).optional(),
  defaultLocale: Locale.default("ar"),
  locales: z.array(Locale).min(1).default(["ar", "en"]),
  settings: BotSettings,
  /** Variables with scope bot, user or conversation. Workflow-scoped ones live on the workflow. */
  variables: z.array(Variable).max(300).default([]),
  /** Names only; values are stored encrypted per environment. */
  configVars: z.array(ConfigVar).max(100).default([]),
  mainWorkflowId: WorkflowId,
  errorWorkflowId: WorkflowId.optional(),
});
export type BotManifest = z.infer<typeof BotManifest>;

/**
 * The complete, self-contained description of a bot's behaviour.
 * Drafts store `manifest` and each workflow as separate documents; a published
 * version stores this object whole and immutable.
 */
export const BotDefinition = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  manifest: BotManifest,
  workflows: z.array(Workflow).min(1).max(200),
});
export type BotDefinition = z.infer<typeof BotDefinition>;

/** Draft document kinds stored in `bot_draft_docs`. */
export const DraftDoc = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("manifest"),
    docId: z.literal("manifest"),
    rev: z.number().int().nonnegative(),
    doc: BotManifest,
  }),
  z.object({ kind: z.literal("workflow"), docId: WorkflowId, rev: z.number().int().nonnegative(), doc: Workflow }),
]);
export type DraftDoc = z.infer<typeof DraftDoc>;
