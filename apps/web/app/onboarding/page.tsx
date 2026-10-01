import { Suspense } from "react";

import { OnboardingGate } from "@/components/auth/session-gate";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export default function Page() {
  return (
    <Suspense fallback={<div className="h-dvh w-full bg-background" />}>
      <OnboardingGate>
        <OnboardingFlow />
      </OnboardingGate>
    </Suspense>
  );
}
