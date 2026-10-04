import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useSessionUser } from "@/lib/session";
import { authClient } from "@/lib/auth-client";
import { onboardingQueryOptions } from "@/lib/queries";
import { refreshBootState } from "@/lib/session";

/**
 * The server gate trusts the session cookie's onboarding flag so pages render
 * without a GitHub round trip. This background read lets the backend confirm
 * GitHub access after render: on a confirmed loss it clears completion and
 * refreshes the cookie, and the user is sent to the onboarding repair flow.
 */
export function useOnboardingRepair(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useSessionUser();
  const onboarding = useQuery(onboardingQueryOptions(user.id));
  const lost = onboarding.data?.completed === false;

  useEffect(() => {
    if (!lost) return;

    // Completion may have been cleared by another request or device, so this
    // browser's cookie can still say complete. Refresh it and the cached boot
    // state first, or the onboarding gate would send the user straight back.
    void authClient
      .getSession({ query: { disableCookieCache: true } })
      .then(() => refreshBootState(queryClient))
      .then(() => navigate({ to: "/onboarding", replace: true }));
  }, [lost, navigate, queryClient]);
}
