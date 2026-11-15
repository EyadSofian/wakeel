import { Secret } from "@wakeel/config";
import type { Tx } from "../client";
import { type Keyring, open, rewrap, seal } from "../crypto";
import { getSecret, listSecrets, putSecret, type SecretSummary } from "./secrets";

/**
 * Plaintext in, plaintext out for `workspace_secrets` (task 1.5). Values are sealed with a per-row
 * data key bound to `workspace_secrets:<workspaceId>:<name>`, so a value copied to another row or
 * workspace does not decrypt. What comes back is wrapped in `Secret` and prints as `[redacted]`.
 */
const aadFor = (workspaceId: string, name: string) => `workspace_secrets:${workspaceId}:${name}`;

export async function storeSecretValue(
  tx: Tx,
  keyring: Keyring,
  input: { workspaceId: string; name: string; value: string },
): Promise<SecretSummary> {
  const sealed = seal(keyring, input.value, aadFor(input.workspaceId, input.name));
  return putSecret(tx, { name: input.name, ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion });
}

export async function readSecretValue(
  tx: Tx,
  keyring: Keyring,
  workspaceId: string,
  name: string,
): Promise<Secret<string> | undefined> {
  const stored = await getSecret(tx, name);
  if (!stored) return undefined;
  const plain = open(keyring, stored, aadFor(workspaceId, name));
  return new Secret(plain.toString("utf8"));
}

/**
 * Re-wraps every secret of the scoped workspace that is not on the current master key version.
 * Returns how many rows changed. The platform-wide rotation job (Phase 15 runbook) calls this per
 * workspace.
 */
export async function rewrapWorkspaceSecrets(tx: Tx, keyring: Keyring, workspaceId: string): Promise<number> {
  let changed = 0;
  for (const summary of await listSecrets(tx)) {
    const stored = await getSecret(tx, summary.name);
    if (!stored || stored.keyVersion === keyring.current.version) continue;
    const next = rewrap(keyring, stored, aadFor(workspaceId, summary.name));
    await putSecret(tx, { name: summary.name, ciphertext: next.ciphertext, keyVersion: next.keyVersion });
    changed++;
  }
  return changed;
}
