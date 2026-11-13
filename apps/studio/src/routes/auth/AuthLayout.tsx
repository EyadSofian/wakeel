import { BRAND } from "@wakeel/config/brand";
import type { ReactNode } from "react";

/**
 * Sign in and its siblings (design system §5.14): a centred 360 px column on the canvas with the
 * product name, one display headline, the form. Nothing else on the page.
 */
export function AuthLayout({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-canvas px-6 pt-12">
      <div className="flex w-sign-in flex-col gap-8 pt-11">
        <div className="flex flex-col gap-2">
          <p className="text-title text-secondary">{BRAND.name}</p>
          <h1 className="text-display text-primary">{heading}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}
