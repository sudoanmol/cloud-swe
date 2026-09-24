import { OnboardingGate } from "@/components/auth/session-gate";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export default function Page() {
  return (
    <OnboardingGate>
      <OnboardingFlow />
    </OnboardingGate>
  );
}
