"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ThreadApiError } from "@cloud-swe/api/client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Landing } from "@/components/landing";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { onboardingQueryOptions } from "@/lib/queries";

/**
 * One gate for every entry path: direct link, client navigation, reload and
 * browser back/forward. Completion is confirmed against a response fetched in
 * this mount, never against a cached cookie or a cached answer alone.
 */
type Gate =
  | { status: "loading" }
  | { status: "signed-out" }
  /** The backend could not be reached; the session is not treated as anonymous. */
  | { status: "unavailable"; retry: () => void }
  | { status: "ready"; completed: boolean; userId: string };

function useGate(): Gate {
  const [mounted, setMounted] = useState(false);
  const session = authClient.useSession();
  const userId = session.data?.user.id;

  const onboarding = useQuery({
    ...onboardingQueryOptions(userId ?? "anonymous"),
    enabled: Boolean(userId),
    // A cached `completed: true` may already be revoked; confirm before mount.
    staleTime: 0,
    refetchOnMount: "always",
  });

  // The clock is read after mount only: a render-time `Date.now()` is illegal
  // while this route can be prerendered.
  const mountedAt = useRef<number | null>(null);
  const confirmationAttempts = useRef(0);

  // A mount can be answered by a refetch that was already in flight from the
  // previous route. That answer predates this mount, so it is not confirmation.
  const confirmed =
    mountedAt.current !== null &&
    onboarding.data !== undefined &&
    onboarding.dataUpdatedAt >= mountedAt.current;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    mountedAt.current = Date.now();
    confirmationAttempts.current = 0;
  }, [userId]);

  useEffect(() => {
    // Ask again when the only answer predates this mount, bounded so a stalled
    // request cannot spin.
    if (confirmed || onboarding.data === undefined || onboarding.fetchStatus !== "idle") return;

    if (confirmationAttempts.current >= 2) return;

    confirmationAttempts.current += 1;
    void onboarding.refetch();
  }, [confirmed, onboarding, onboarding.data, onboarding.fetchStatus]);

  const retry = () => {
    void session.refetch();
    void onboarding.refetch();
  };

  if (!mounted || session.isPending) return { status: "loading" };

  // A failed session read means the auth server is unreachable, not signed out.
  if (session.error) return { status: "unavailable", retry };

  if (!session.data) return { status: "signed-out" };

  if (onboarding.isPending) return { status: "loading" };

  if (onboarding.isError) {
    // An expired session is final here: retrying only loops on 401.
    if (onboarding.error instanceof ThreadApiError && onboarding.error.status === 401)
      return { status: "signed-out" };

    return { status: "unavailable", retry };
  }

  if (!confirmed) return { status: "loading" };

  return { status: "ready", completed: onboarding.data.completed, userId: session.data.user.id };
}

function useRedirect(when: boolean, target: string): void {
  const router = useRouter();

  useEffect(() => {
    if (when) router.replace(target);
  }, [router, target, when]);
}

function SessionShell() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background">
      <span aria-live="polite" className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner />
        Loading cloud-swe
      </span>
    </div>
  );
}

function BackendUnavailable({ retry }: { retry: () => void }) {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RefreshCwIcon />
          </EmptyMedia>
          <EmptyTitle>cloud-swe is unreachable</EmptyTitle>
          <EmptyDescription>
            Your session is still active, but setup state could not be loaded.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={retry} type="button">
            <RefreshCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/**
 * The product subtree is keyed by user id, so switching accounts unmounts every
 * draft, selection and pending dialog instead of leaving them for the next user.
 */
function AccountBoundary({ userId, children }: { userId: string; children: React.ReactNode }) {
  return <Fragment key={userId}>{children}</Fragment>;
}

/** Protected product routes: session plus confirmed onboarding completion. */
export function AppGate({ children }: { children: React.ReactNode }) {
  const gate = useGate();
  const needsRepair = gate.status === "ready" && !gate.completed;

  useRedirect(gate.status === "signed-out" || needsRepair, needsRepair ? "/onboarding" : "/");

  if (gate.status === "loading") return <SessionShell />;

  if (gate.status === "signed-out") return <Landing />;

  if (gate.status === "unavailable") return <BackendUnavailable retry={gate.retry} />;

  if (needsRepair) return <SessionShell />;

  return <AccountBoundary userId={gate.userId}>{children}</AccountBoundary>;
}

/** Onboarding route: session required, completion sends the user back to the app. */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const gate = useGate();
  const done = gate.status === "ready" && gate.completed;

  useRedirect(gate.status === "signed-out" || done, "/");

  if (gate.status === "loading") return <SessionShell />;

  if (gate.status === "signed-out") return <Landing />;

  if (gate.status === "unavailable") return <BackendUnavailable retry={gate.retry} />;

  if (done) return <SessionShell />;

  return <AccountBoundary userId={gate.userId}>{children}</AccountBoundary>;
}
