import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { BackendUnavailable } from "@/components/auth/backend-unavailable";
import { ProductShell } from "@/components/chat/product-shell";
import { Landing } from "@/components/landing";

/**
 * Pathless layout for `/`, `/agent/$id` and `/settings`: a session plus
 * completed onboarding. Client navigations between them keep this layout, so the
 * shell mounts once per page load. Anonymous visitors see the landing at `/` and
 * are sent there from every other product path.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context: { boot }, location }) => {
    const { session } = boot;

    if (session.status === "unavailable") return { user: null };

    if (session.status === "signed-out") {
      if (location.pathname !== "/") throw redirect({ to: "/" });

      return { user: null };
    }

    if (!session.user.onboardingCompleted) throw redirect({ to: "/onboarding" });

    return { user: session.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const { boot, user } = Route.useRouteContext();

  if (boot.session.status === "unavailable") return <BackendUnavailable />;

  if (!user) return <Landing />;

  // Keyed by user so no draft or selection outlives its account.
  return (
    <ProductShell defaultSidebarOpen={boot.sidebarOpen} key={user.id}>
      <Outlet />
    </ProductShell>
  );
}
