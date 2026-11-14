import type { Option } from "@wakeel/contracts";
import { motion } from "motion/react";
import { useMotionTokens } from "../use-motion-tokens";

/**
 * Choice buttons under a bot message (§5.3). They fade in (120 ms) after the text, and stay visible
 * but unusable once the conversation has moved on, so the transcript still shows what was offered.
 */
export function QuickReplies({
  options,
  onPick,
  disabled = false,
}: {
  options: readonly Option[];
  onPick: ((option: Option) => void) | undefined;
  disabled?: boolean;
}) {
  const tokens = useMotionTokens();
  const usable = !disabled && onPick !== undefined;
  return (
    <motion.div
      role="group"
      aria-label="Choices"
      className="flex max-w-4/5 flex-wrap gap-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: tokens.duration.fast, ease: tokens.ease.out }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={!usable}
          onClick={() => onPick?.(o)}
          className="inline-flex h-control-sm items-center rounded-full border border-accent-border bg-surface px-5 text-small font-medium text-accent-text transition-colors hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-accent disabled:border-hairline disabled:text-tertiary disabled:hover:bg-surface"
        >
          <span dir="auto">{o.label}</span>
        </button>
      ))}
    </motion.div>
  );
}
