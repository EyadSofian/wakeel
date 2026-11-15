# ADR-037 — Config variable values: who may set them, what is shown, and the redaction set

Status: proposed (implemented as proposed in task 7.3 🔒; review with that PR) · Date: 2026-11-15

## Context

Architecture §2.3 defines `bot_config_vars (bot_id, env, key, ciphertext, key_version, is_secret)` with `env ∈ draft | production`. The manifest declares the names (`configVars`, each with `secret`). Code reads the values as `env.<KEY>`. Design system §5.7 says the Secrets and settings tab has separate Draft and Production values and that secret values are write-only. Task 7.3 needs answers the docs leave open:

1. Which environment a turn reads.
2. Which role may set a value.
3. What the Studio may read back.
4. What the "redaction set" covers beyond the sandbox's own log redaction (ADR-023 §6).

## Decision

1. **A conversation on a published version reads production values; one running the draft reads draft values.** That makes emulator, Test-tab and draft-connection conversations draft, and live production conversations production (ADR-036).
2. **Setting or deleting a value needs `bot.update`. When the manifest declares the key secret, it also needs `secret.write`**, which builders do not have (task 1.3: builders cannot manage secrets). Only keys the draft manifest declares can be set (`validation_failed` otherwise). Audit entries `config_var.set` and `config_var.deleted` record the key, environment and whether it is secret, never the value.
3. **Every value is sealed at rest**, secret or not, with the envelope helper (task 1.5), bound to `bot_config_vars:<workspace>:<bot>:<env>:<key>`. `GET …/bots/{botId}/config` lists each declared key with, per environment, whether a value is set and the value itself **only when the key is not secret**. No route ever returns a secret value.
4. **The redaction set is the plaintext of the turn's secret values**, minimum 4 characters. The worker replaces each occurrence with `[redacted]` in every span it writes: variable writes, model prompts, tool inputs and outputs, and error messages, whole or inside longer strings. Logs never carry values; the sandbox redacts guest logs by key as before.

## Consequences

- A secret that the bot itself says to the user still reaches the user. That is the bot's behaviour, and the trace of it is scrubbed.
- Short secrets (under 4 characters) are not scrubbed, since they would also match ordinary text. The Studio can warn when a secret is that short.
- Rotating the master key re-wraps these rows with the same job as `workspace_secrets` (Phase 15 runbook).
