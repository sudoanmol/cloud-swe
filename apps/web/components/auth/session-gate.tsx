import { redirect } from "next/navigation";

import { BackendUnavailable } from "@/components/auth/backend-unavailable";
import { SessionProvider } from "@/components/auth/session-provider";
import { getServerSession } from "@/lib/server-session";

/**
 * Server gates for every entry path. The session and onboarding flag are read
 * during the server render, so the page arrives already resolved. The product
 * subtree is keyed by user id, so no draft or selection outlives its account.
 */

/** Product routes: a session plus completed onboarding. */
export async function AppGate({
  children,
  signedOut,
}: {
  children: React.ReactNode;
  /** Rendered for anonymous visitors; omitted routes send them to `/`. */
  signedOut?: React.ReactNode;
}) {
  const session = await getServerSession();

  if (session.status === "unavailable") return <BackendUnavailable />;

  if (session.status === "signed-out") {
    if (signedOut === undefined) redirect("/");

    return signedOut;
  }

  if (!session.user.onboardingCompleted) redirect("/onboarding");

  return (
    <SessionProvider key={session.user.id} user={session.user}>
      {children}
    </SessionProvider>
  );
}

/** Onboarding route: a session without completed onboarding. */
export async function OnboardingGate({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();

  if (session.status === "unavailable") return <BackendUnavailable />;

  if (session.status === "signed-out" || session.user.onboardingCompleted) redirect("/");

  return (
    <SessionProvider key={session.user.id} user={session.user}>
      {children}
    </SessionProvider>
  );
}
