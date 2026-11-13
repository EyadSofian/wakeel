import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { enterTransition, exitTransition } from "../motion";
import { useMotionTokens } from "../use-motion-tokens";

/**
 * Dialog (design system §4, §2.4–2.6): Radix behaviour (focus trap, Escape, focus restored to the
 * trigger), our look: 12 px radius, modal shadow, a scrim without blur. Enters with `spring.gentle`
 * and a short rise; exits with a fade.
 */
export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Buttons on the end side: the cancel action first, the primary action last. */
  footer: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
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
                animate={{ opacity: 1, transition: enterTransition(tokens).opacity }}
                exit={{ opacity: 0, transition: exitTransition(tokens) }}
              />
            </RadixDialog.Overlay>
            <div className="pointer-events-none fixed inset-0 flex items-start justify-center pt-12">
              <RadixDialog.Content asChild forceMount>
                <motion.div
                  className="pointer-events-auto flex w-inspector-max flex-col rounded-lg border border-hairline bg-surface shadow-modal"
                  initial={{ opacity: 0, y: tokens.travel }}
                  animate={{ opacity: 1, y: 0, transition: enterTransition(tokens) }}
                  exit={{ opacity: 0, transition: exitTransition(tokens) }}
                  {...(description === undefined ? { "aria-describedby": undefined } : {})}
                >
                  <div className="flex flex-col gap-2 px-6 pt-6">
                    <RadixDialog.Title className="text-title text-primary">{title}</RadixDialog.Title>
                    {description ? (
                      <RadixDialog.Description className="text-body text-secondary">
                        {description}
                      </RadixDialog.Description>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-6 px-6 py-6">{children}</div>
                  <div className="flex justify-end gap-4 border-t border-hairline px-6 py-5">{footer}</div>
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
