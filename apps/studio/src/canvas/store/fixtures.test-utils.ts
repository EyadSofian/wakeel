import { BotManifest, seedBot, Workflow } from "@wakeel/contracts";

/** A bot to edit in tests: the seeded draft, parsed as the api would return it. */
export function seededDraft() {
  const s = seedBot({ name: "متجر النور" });
  return { manifest: BotManifest.parse(s.manifest), main: Workflow.parse(s.main) };
}

/** Deterministic pseudo-random numbers (mulberry32), so a failing sequence can be replayed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
