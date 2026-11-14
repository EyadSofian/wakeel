import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMotionTokens } from "../use-motion-tokens";

export interface TranscriptItem {
  key: string;
  /** User messages rise in from below; bot messages and banners fade in where they land. */
  side: "user" | "bot" | "system";
  node: ReactNode;
}

/**
 * The scrolling transcript (§5.3 motion table). A user bubble rises 8 px and fades in on
 * `spring.snappy`; the list's height follows on `spring.smooth`. It sticks to the bottom only while
 * the reader is at the bottom; otherwise a "New messages" chip appears.
 */
export function TranscriptList({
  items,
  footer,
  label,
}: {
  items: TranscriptItem[];
  footer?: ReactNode;
  label: string;
}) {
  const tokens = useMotionTokens();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const count = items.length;

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // Within one control height of the end counts as the bottom.
    const slack = el.clientHeight * 0.05;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
    if (atBottom.current) setUnseen(false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when items or the footer change.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (count > 0) setUnseen(true);
  }, [count, footer]);

  useEffect(() => {
    if (count === 0) setUnseen(false);
  }, [count]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: tokens.reduced ? "auto" : "smooth" });
    atBottom.current = true;
    setUnseen(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label={label}
        aria-live="polite"
        className="flex h-full flex-col gap-5 overflow-y-auto px-5 py-6"
      >
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.div
              key={item.key}
              layout="position"
              className="flex flex-col"
              initial={{ opacity: 0, y: item.side === "user" ? tokens.travel : 0 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{
                layout: tokens.spring.smooth,
                y: tokens.spring.snappy,
                opacity: { duration: tokens.duration.fast, ease: tokens.ease.out },
              }}
            >
              {item.node}
            </motion.div>
          ))}
        </AnimatePresence>
        {footer}
      </div>
      {unseen ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute inset-x-0 bottom-4 mx-auto flex h-control-sm w-fit items-center gap-2 rounded-full border border-hairline bg-surface px-5 text-small font-medium text-primary shadow-pop"
        >
          <ArrowDown className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
          New messages
        </button>
      ) : null}
    </div>
  );
}
