import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { enterTransition, exitTransition, scale } from "../motion";
import { useMotionTokens } from "../use-motion-tokens";

/** Which way "towards the end edge" points in the page's direction: 1 in LTR, -1 in RTL. */
const endSign = () => (typeof document !== "undefined" && document.documentElement.dir === "rtl" ? -1 : 1);

/**
 * Sheet (design system §4, §5.16): a full-height panel over the screen from the end edge, docked to
 * the window edge (radius 0), over a scrim. Radix behaviour: focus trap, `Esc`, focus restored.
 * Enters with a short travel from the end side on `spring.smooth`; exits with a fade.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Call `preventDefault()` to keep focus where a choice in the sheet moved it. */
  onCloseAutoFocus?: (e: Event) => void;
  children: ReactNode;
}) {
  const tokens = useMotionTokens();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 bg-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: enterTransition(tokens, "smooth").opacity }}
                exit={{ opacity: 0, transition: exitTransition(tokens, "smooth") }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content
              asChild
              forceMount
              {...(description === undefined ? { "aria-describedby": undefined } : {})}
              {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
            >
              <motion.div
                className="fixed inset-y-0 end-0 flex w-inspector-max max-w-full flex-col border-s border-hairline bg-surface shadow-modal"
                initial={{ opacity: 0, x: tokens.travel * endSign() }}
                animate={{ opacity: 1, x: 0, transition: enterTransition(tokens, "smooth") }}
                exit={{ opacity: 0, transition: exitTransition(tokens, "smooth") }}
              >
                <header className="flex min-h-topbar shrink-0 items-center gap-4 border-b border-hairline py-4 pe-5 ps-7">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <RadixDialog.Title className="truncate text-title text-primary">{title}</RadixDialog.Title>
                    {description ? (
                      <RadixDialog.Description className="truncate text-small text-secondary">
                        {description}
                      </RadixDialog.Description>
                    ) : null}
                  </div>
                  <RadixDialog.Close
                    aria-label="Close"
                    title="Close (Esc)"
                    className="flex size-control-sm items-center justify-center rounded-sm text-secondary transition-colors hover:bg-subtle hover:text-primary"
                  >
                    <X className="size-icon" strokeWidth={1.75} aria-hidden="true" />
                  </RadixDialog.Close>
                </header>
                <div className="min-h-0 flex-1 overflow-auto">{children}</div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

/**
 * The frame of the command palette (design system §5.15): 640 wide, its top at 20% of the
 * viewport, `--radius-xl`, `--shadow-modal`. Opens on `spring.gentle` (scale 0.98 → 1 and fade),
 * closes in 120 ms. `onCloseAutoFocus` lets the palette keep focus where an action put it.
 */
export function PaletteFrame({
  open,
  onOpenChange,
  label,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onCloseAutoFocus?: (e: Event) => void;
  children: ReactNode;
}) {
  const tokens = useMotionTokens();
  const close = { type: "tween", duration: tokens.duration.fast, ease: tokens.ease.out } as const;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 bg-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: enterTransition(tokens).opacity }}
                exit={{ opacity: 0, transition: close }}
              />
            </RadixDialog.Overlay>
            <div className="pointer-events-none fixed inset-0 flex items-start justify-center px-6 pt-palette-top">
              <RadixDialog.Content
                asChild
                forceMount
                aria-describedby={undefined}
                {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
              >
                <motion.div
                  className="pointer-events-auto flex max-h-picker-height w-palette max-w-full flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-modal"
                  initial={{ opacity: 0, scale: tokens.reduced ? 1 : scale.palette }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    transition: { scale: tokens.spring.gentle, opacity: enterTransition(tokens).opacity },
                  }}
                  exit={{ opacity: 0, transition: close }}
                >
                  <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
                  {children}
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
