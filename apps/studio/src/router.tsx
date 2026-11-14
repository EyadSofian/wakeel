import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  redirect,
  useParams,
} from "@tanstack/react-router";
import { z } from "zod";
import { useSession, useWorkspaces } from "./api/queries";
import { AcceptInvite } from "./routes/auth/AcceptInvite";
import { NewWorkspace } from "./routes/auth/NewWorkspace";
import { SignIn, SignUp } from "./routes/auth/SignIn";
import { BotCanvas } from "./routes/bot/BotCanvas";
import { BotLayout } from "./routes/bot/BotLayout";
import { ConnectionDetail, type ConnectionTab } from "./routes/connections/ConnectionDetail";
import { ConnectionsScreen } from "./routes/connections/ConnectionsScreen";
import { Gallery } from "./routes/Gallery";
import { VariablesScreen } from "./routes/variables/VariablesScreen";
import { ApiKeys } from "./routes/workspace/ApiKeys";
import { General } from "./routes/workspace/General";
import { Home } from "./routes/workspace/Home";
import { Members } from "./routes/workspace/Members";
import { AppShell } from "./shell/AppShell";
import { RequireSession } from "./shell/RequireSession";
import { ErrorState, NotFoundState } from "./shell/States";

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundState,
  errorComponent: () => <ErrorState />,
});

/** `/`: signed out → sign in; no workspace yet → create one; otherwise the first workspace. */
function Landing() {
  const session = useSession();
  const workspaces = useWorkspaces(session.data != null);
  if (session.isPending) return null;
  if (session.isError) return <ErrorState />;
  if (session.data === null) return <Navigate to="/sign-in" replace />;
  if (workspaces.isPending) return null;
  if (workspaces.isError) return <ErrorState />;
  const first = workspaces.data[0];
  if (!first) return <Navigate to="/new" replace />;
  return <Navigate to="/w/$workspaceId" params={{ workspaceId: first.id }} replace />;
}

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Landing });

const redirectSearch = z.object({ redirect: z.string().max(2000).optional() });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: redirectSearch,
  component: function SignInRoute() {
    const { redirect: to } = signInRoute.useSearch();
    return <SignIn {...(to === undefined ? {} : { redirect: to })} />;
  },
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-up",
  validateSearch: redirectSearch,
  component: function SignUpRoute() {
    const { redirect: to } = signUpRoute.useSearch();
    return <SignUp {...(to === undefined ? {} : { redirect: to })} />;
  },
});

const newWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  component: () => <RequireSession>{() => <NewWorkspace />}</RequireSession>,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: function InviteRoute() {
    const { token } = inviteRoute.useParams();
    return <RequireSession>{() => <AcceptInvite token={token} />}</RequireSession>;
  },
});

const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/w/$workspaceId" });

const homeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  component: function HomeRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    return <RequireSession>{() => <Home workspaceId={workspaceId} />}</RequireSession>;
  },
});

/** One bot: loads its draft once for the canvas and the Variables screen (BotLayout). */
const botRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/b/$botId",
  component: function BotRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    const { botId } = botRoute.useParams();
    return <RequireSession>{() => <BotLayout key={botId} workspaceId={workspaceId} botId={botId} />}</RequireSession>;
  },
});

const botCanvasRoute = createRoute({
  getParentRoute: () => botRoute,
  path: "/",
  component: function BotCanvasRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    const { botId } = botRoute.useParams();
    return <BotCanvas workspaceId={workspaceId} botId={botId} />;
  },
});

const botVariablesRoute = createRoute({
  getParentRoute: () => botRoute,
  path: "/variables",
  component: function BotVariablesRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    const { botId } = botRoute.useParams();
    return <VariablesScreen workspaceId={workspaceId} botId={botId} />;
  },
});

/** Connections (task 5.5, design system §5.11): the list, and one connection's tabs as addresses. */
const botConnectionsRoute = createRoute({
  getParentRoute: () => botRoute,
  path: "/connections",
  component: function BotConnectionsRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    const { botId } = botRoute.useParams();
    return <ConnectionsScreen workspaceId={workspaceId} botId={botId} />;
  },
});

function ConnectionRoute({ tab }: { tab: ConnectionTab }) {
  const { workspaceId } = workspaceRoute.useParams();
  const { botId } = botRoute.useParams();
  const { connectionId } = useParams({ strict: false }) as { connectionId: string };
  return (
    <ConnectionDetail
      key={connectionId}
      workspaceId={workspaceId}
      botId={botId}
      connectionId={connectionId}
      tab={tab}
    />
  );
}
const connectionSetupRoute = createRoute({
  getParentRoute: () => botRoute,
  path: "/connections/$connectionId",
  component: () => <ConnectionRoute tab="setup" />,
});
const connectionDeliveriesRoute = createRoute({
  getParentRoute: () => botRoute,
  path: "/connections/$connectionId/deliveries",
  component: () => <ConnectionRoute tab="deliveries" />,
});
const connectionTestRoute = createRoute({
  getParentRoute: () => botRoute,
  path: "/connections/$connectionId/test",
  component: () => <ConnectionRoute tab="test" />,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/settings",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/w/$workspaceId/settings/general", params });
  },
});

const generalRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/settings/general",
  component: function GeneralRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    return <RequireSession>{() => <General workspaceId={workspaceId} />}</RequireSession>;
  },
});

const membersRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/settings/members",
  component: function MembersRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    return <RequireSession>{() => <Members workspaceId={workspaceId} />}</RequireSession>;
  },
});

const apiKeysRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/settings/api-keys",
  component: function ApiKeysRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    return <RequireSession>{() => <ApiKeys workspaceId={workspaceId} />}</RequireSession>;
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
  routeTree: rootRoute.addChildren([
    indexRoute,
    signInRoute,
    signUpRoute,
    newWorkspaceRoute,
    inviteRoute,
    workspaceRoute.addChildren([
      homeRoute,
      botRoute.addChildren([
        botCanvasRoute,
        botVariablesRoute,
        botConnectionsRoute,
        connectionSetupRoute,
        connectionDeliveriesRoute,
        connectionTestRoute,
      ]),
      settingsIndexRoute,
      generalRoute,
      membersRoute,
      apiKeysRoute,
    ]),
    galleryRoute,
    errorPreviewRoute,
  ]),
  defaultNotFoundComponent: NotFoundState,
  defaultErrorComponent: () => <ErrorState />,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
