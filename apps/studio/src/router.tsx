import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { Gallery } from "./routes/Gallery";
import { AppShell } from "./shell/AppShell";
import { ErrorState, NotFoundState } from "./shell/States";

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundState,
  errorComponent: () => <ErrorState />,
});

/** Until the workspace home exists (task 1.7), the root opens the gallery. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/__gallery" });
  },
});

const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__gallery",
  component: () => (
    <AppShell title="Gallery">
      <Gallery />
    </AppShell>
  ),
});

/** Dev-only: renders the error state so the review loop can shoot it. */
const errorPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__gallery/error",
  loader: () => {
    throw new Error("Error state preview");
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, galleryRoute, errorPreviewRoute]),
  defaultNotFoundComponent: NotFoundState,
  defaultErrorComponent: () => <ErrorState />,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
