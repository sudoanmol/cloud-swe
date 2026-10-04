import { createFileRoute, redirect } from "@tanstack/react-router";

import { BackendUnavailable } from "@/components/auth/backend-unavailable";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

/** A session without completed onboarding; everyone else belongs at `/`. */
export const Route = createFileRoute("/onboarding")({
  beforeLoad: ({ context: { boot } }) => {
    const { session } = boot;

    if (session.status === "unavailable") return { user: null };

    if (session.status === "signed-out" || session.user.onboardingCompleted)
      throw redirect({ to: "/" });

    return { user: session.user };
  },
  component: OnboardingRoute,
});

function OnboardingRoute() {
  const { user } = Route.useRouteContext();

  if (!user) return <BackendUnavailable />;

  return <OnboardingFlow key={user.id} />;
}
