"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useSessionUser } from "@/components/auth/session-provider";
import { authClient } from "@/lib/auth-client";
import { onboardingQueryOptions } from "@/lib/queries";

/**
 * The server gate trusts the session cookie's onboarding flag so pages render
 * without a GitHub round trip. This background read lets the backend confirm
 * GitHub access after render: on a confirmed loss it clears completion and
 * refreshes the cookie, and the user is sent to the onboarding repair flow.
 */
export function useOnboardingRepair(): void {
  const router = useRouter();
  const user = useSessionUser();
  const onboarding = useQuery(onboardingQueryOptions(user.id));
  const lost = onboarding.data?.completed === false;

  useEffect(() => {
    if (!lost) return;

    // Completion may have been cleared by another request or device, so this
    // browser's cookie can still say complete. Refresh it first, or the server
    // gate would send the user straight back here.
    void authClient
      .getSession({ query: { disableCookieCache: true } })
      .then(() => router.replace("/onboarding"));
  }, [lost, router]);
}
