import type { OnboardingResponse } from "@cloud-swe/api/contracts";
import { CheckIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type GithubStepProps = {
  github: OnboardingResponse["github"];
  onRecheck: () => void;
  checking: boolean;
};

/**
 * Step 1. Readiness is a server observation: an install URL alone is never
 * proof, and a GitHub query-string installation id is never read here.
 */
export function GithubStep({ github, onRecheck, checking }: GithubStepProps) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-medium text-base">Connect GitHub</h2>
        <p className="text-muted-foreground text-sm">
          Install the cloud-swe GitHub App and grant it at least one repository. Private access goes
          through the backend broker, never the browser.
        </p>
      </header>

      {github.ready ? (
        <Alert>
          <CheckIcon />
          <AlertTitle>GitHub is ready</AlertTitle>
          <AlertDescription>
            At least one installation of this app exposes a readable repository.
          </AlertDescription>
        </Alert>
      ) : github.transientError ? (
        <Alert variant="destructive">
          <AlertTitle>GitHub could not be verified</AlertTitle>
          <AlertDescription>
            Installation state is temporarily unavailable. Nothing was revoked; check again.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>No repository access yet</AlertTitle>
          <AlertDescription>
            After installing, grant the app at least one repository. Organization requests need
            approval before they count as ready.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        {github.installUrl ? (
          <Button asChild>
            <a href={github.installUrl} rel="noreferrer" target="_blank">
              Install GitHub App
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        ) : null}
        <Button disabled={checking} onClick={onRecheck} type="button" variant="outline">
          <RefreshCwIcon data-icon="inline-start" />
          {checking ? "Checking" : "Check again"}
        </Button>
      </div>
    </section>
  );
}
