"use client";

import { ThreadApiError } from "@cloud-swe/api/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAccountGuard } from "@/lib/account-scope";
import { authClient } from "@/lib/auth-client";
import { completeOnboardingMutation, onboardingQueryOptions } from "@/lib/queries";
import { GithubStep } from "./github-step";
import { ProviderConnections } from "./provider-connections";

function conflictMessage(error: ThreadApiError): string {
  if (error.code === "PROVIDER_REQUIRED") return "Connect a model provider before finishing.";

  if (error.code === "GITHUB_REPOSITORY_REQUIRED")
    return "Install the GitHub App and grant at least one repository.";

  return "Setup could not be completed. Check the steps above and try again.";
}

/** Two-step onboarding: GitHub access, then a model provider. */
export function OnboardingFlow() {
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? "anonymous";
  const queryClient = useQueryClient();
  const router = useRouter();
  const guardAccount = useAccountGuard();
  const onboarding = useQuery(onboardingQueryOptions(userId));

  const complete = useMutation({
    ...completeOnboardingMutation(),
    onSuccess: async () => {
      // A late reply from a previous account must not navigate this one.
      if (!guardAccount(userId)) return;

      // Refresh the signed session cookie cache through Better Auth's HTTP
      // handler so the durable flag reaches the browser before navigating.
      await authClient.getSession({ query: { disableCookieCache: true } });
      await queryClient.invalidateQueries({ queryKey: ["session", userId] });
      router.replace("/");
    },
  });

  if (onboarding.isPending)
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-16">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );

  if (onboarding.isError || !onboarding.data)
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-16">
        <Alert variant="destructive">
          <AlertTitle>Setup state could not be loaded</AlertTitle>
          <AlertDescription>
            <Button
              onClick={() => {
                void onboarding.refetch();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );

  const { github, providerReady } = onboarding.data;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-16">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl tracking-tight">Set up cloud-swe</h1>
        <p className="text-muted-foreground text-sm">
          Two steps: repository access and a model provider. Nothing runs until both are ready.
        </p>
      </header>

      <GithubStep
        checking={onboarding.isFetching}
        github={github}
        onRecheck={() => {
          void onboarding.refetch();
        }}
      />

      <Separator />

      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 className="font-medium text-base">Connect a model provider</h2>
          <p className="text-muted-foreground text-sm">
            Credentials are encrypted on the server and used for your runs only.
          </p>
        </header>
        <ProviderConnections userId={userId} />
      </section>

      <Separator />

      <footer className="flex flex-col gap-3">
        {complete.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Setup is not complete</AlertTitle>
            <AlertDescription>
              {complete.error instanceof ThreadApiError
                ? conflictMessage(complete.error)
                : "Setup could not be completed. Try again."}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">
            {github.ready ? "GitHub ready" : "GitHub pending"} ·{" "}
            {providerReady ? "provider ready" : "provider pending"}
          </span>
          <Button
            disabled={complete.isPending || !github.ready || !providerReady}
            onClick={() => complete.mutate()}
            type="button"
          >
            {complete.isPending ? <Spinner data-icon="inline-start" /> : null}
            Finish setup
          </Button>
        </div>
      </footer>
    </main>
  );
}
