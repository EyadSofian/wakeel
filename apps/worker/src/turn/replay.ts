import { AppError, type Json } from "@wakeel/contracts";
import type { CodePort } from "@wakeel/engine";
import { z } from "zod";

const replay = z.object({ sourceTurnId: z.string(), allowSideEffects: z.boolean(), group: z.string() });

/** Read flags inserted by the authenticated replay API, without treating user metadata as policy. */
export function replayPolicy(mode: string, payload: Record<string, Json>) {
  if (mode !== "emulator") return undefined;
  const parsed = replay.safeParse(payload["replay"]);
  return parsed.success ? parsed.data : undefined;
}

/** A replay's unconfirmed Code card stops before entering the sandbox. */
export function replayCodePort(code: CodePort, enabled: boolean): CodePort {
  return enabled
    ? code
    : {
        run: async () => {
          throw new AppError("replay_side_effect_blocked");
        },
      };
}
