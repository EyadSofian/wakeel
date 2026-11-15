import { useReducedMotion } from "motion/react";
import { type MotionTokens, motionTokens } from "./motion";

/**
 * The motion tokens for the current user (design system §2.6). Components call this instead of
 * checking `prefers-reduced-motion` themselves; with reduced motion every spring and travel becomes
 * an 80 ms opacity change.
 */
export function useMotionTokens(): MotionTokens {
  return motionTokens(useReducedMotion() === true);
}
