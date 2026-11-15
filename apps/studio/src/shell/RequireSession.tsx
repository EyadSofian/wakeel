import { useLocation, useNavigate } from "@tanstack/react-router";
import type { SessionResponse } from "@wakeel/contracts";
import { type ReactNode, useEffect, useRef } from "react";
import { useSession } from "../api/queries";
import { ErrorState } from "./States";

/**
 * Renders children with the session, or sends a signed-out user to sign in and back.
 *
 * The redirect fires once, with the address the user asked for. While the navigation runs this
 * component is still mounted and `useLocation` already reports `/sign-in?redirect=…`; redirecting
 * again from there nested the redirect into itself until the tab crashed (found by the e2e suite on
 * /invite/<token>).
 */
export function RequireSession({ children }: { children: (session: SessionResponse) => ReactNode }) {
  const session = useSession();
  const { href } = useLocation();
  const navigate = useNavigate();
  const requested = useRef(href);
  const redirected = useRef(false);
  const signedOut = session.data === null;
  useEffect(() => {
    if (!signedOut || redirected.current) return;
    redirected.current = true;
    void navigate({ to: "/sign-in", search: { redirect: requested.current }, replace: true });
  }, [signedOut, navigate]);
  if (session.isError) return <ErrorState />;
  if (session.isPending || session.data === null) return null;
  return <>{children(session.data)}</>;
}
