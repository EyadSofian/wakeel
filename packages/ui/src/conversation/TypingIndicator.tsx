import { motion } from "motion/react";
import { useMotionTokens } from "../use-motion-tokens";

/**
 * Three dots while a turn runs (§5.3): they appear only if nothing has arrived 300 ms after the turn
 * starts, then loop opacity every 1.2 s — the one looping animation the design system allows. With
 * reduced motion it is the static text "Typing…".
 */
export function TypingIndicator({ label = "Typing…" }: { label?: string }) {
  const tokens = useMotionTokens();
  const loop = tokens.typing.loop;
  return (
    <motion.div
      role="status"
      aria-label={label}
      className="flex h-control items-center self-start rounded-lg border border-hairline bg-surface px-5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: tokens.typing.appearAfter, duration: tokens.duration.fast, ease: tokens.ease.out }}
    >
      {loop === null ? (
        <span className="text-small text-secondary">{label}</span>
      ) : (
        <span aria-hidden="true" className="flex items-center gap-2">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-status-dot rounded-full bg-tertiary"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{
                duration: loop,
                repeat: Number.POSITIVE_INFINITY,
                ease: tokens.ease.out,
                delay: (i * loop) / 6,
              }}
            />
          ))}
        </span>
      )}
    </motion.div>
  );
}
