import { AppError } from "@wakeel/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { type Keyring, open, seal } from "../crypto";
import { botConfigVars } from "../schema/bots";
import { currentWorkspace } from "./scope";

/**
 * Config variable values (task 7.3, ADR-037): one sealed value per bot, environment and key. The
 * draft environment serves the emulator and draft connections; production serves live traffic on a
 * published version. Secret values never leave this module except to the turn worker, which passes
 * them to the sandbox as `env` and scrubs them from everything it records.
 */

export type ConfigEnv = "draft" | "production";

export interface ConfigValueSummary {
  key: string;
  env: ConfigEnv;
  isSecret: boolean;
  /** The value of a non-secret setting; always null for a secret. */
  value: string | null;
  updatedAt: Date;
}

/** Values are bound to their row, so a copied ciphertext does not open anywhere else. */
const aadFor = (workspaceId: string, botId: string, env: ConfigEnv, key: string) =>
  `bot_config_vars:${workspaceId}:${botId}:${env}:${key}`;

/** Sets one value; replaces any previous value for the same bot, environment and key. */
export async function putConfigValue(
  tx: Tx,
  keyring: Keyring,
  input: {
    workspaceId: string;
    botId: string;
    env: ConfigEnv;
    key: string;
    value: string;
    isSecret: boolean;
    userId: string | null;
  },
): Promise<void> {
  const sealed = seal(keyring, input.value, aadFor(input.workspaceId, input.botId, input.env, input.key));
  await tx
    .insert(botConfigVars)
    .values({
      workspaceId: currentWorkspace,
      botId: input.botId,
      env: input.env,
      key: input.key,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      isSecret: input.isSecret,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [botConfigVars.botId, botConfigVars.env, botConfigVars.key],
      set: {
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        isSecret: input.isSecret,
        updatedBy: input.userId,
        updatedAt: sql`now()`,
      },
    });
}

export async function deleteConfigValue(tx: Tx, botId: string, env: ConfigEnv, key: string): Promise<void> {
  const deleted = await tx
    .delete(botConfigVars)
    .where(and(eq(botConfigVars.botId, botId), eq(botConfigVars.env, env), eq(botConfigVars.key, key)))
    .returning({ key: botConfigVars.key });
  if (deleted.length === 0) throw new AppError("not_found");
}

/** What the Studio may show: which values are set, and the value of non-secret settings only. */
export async function listConfigValues(
  tx: Tx,
  keyring: Keyring,
  workspaceId: string,
  botId: string,
): Promise<ConfigValueSummary[]> {
  const rows = await tx
    .select()
    .from(botConfigVars)
    .where(eq(botConfigVars.botId, botId))
    .orderBy(asc(botConfigVars.key), asc(botConfigVars.env));
  return rows.map((r) => ({
    key: r.key,
    env: r.env as ConfigEnv,
    isSecret: r.isSecret,
    value: r.isSecret
      ? null
      : open(
          keyring,
          { ciphertext: r.ciphertext, keyVersion: r.keyVersion },
          aadFor(workspaceId, botId, r.env as ConfigEnv, r.key),
        ).toString("utf8"),
    updatedAt: r.updatedAt,
  }));
}

/**
 * Every value of one environment, decrypted, for a turn: `values` becomes the guest's `env` and
 * `secrets` is the redaction set (the plaintext of every secret value).
 */
export async function loadConfigEnv(
  tx: Tx,
  keyring: Keyring,
  workspaceId: string,
  botId: string,
  env: ConfigEnv,
): Promise<{ values: Record<string, string>; secrets: string[] }> {
  const rows = await tx
    .select()
    .from(botConfigVars)
    .where(and(eq(botConfigVars.botId, botId), eq(botConfigVars.env, env)));
  const values: Record<string, string> = {};
  const secrets: string[] = [];
  for (const r of rows) {
    const plain = open(
      keyring,
      { ciphertext: r.ciphertext, keyVersion: r.keyVersion },
      aadFor(workspaceId, botId, env, r.key),
    ).toString("utf8");
    values[r.key] = plain;
    if (r.isSecret && plain.length > 0) secrets.push(plain);
  }
  return { values, secrets };
}
