import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { GithubIcon } from "lucide-react";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

// Loaded only for the signed-out landing, never for chat or onboarding.
const PixelField = lazy(() =>
  import("@/components/landing/pixel-field").then((module) => ({ default: module.PixelField })),
);

export function Landing() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSignIn() {
    setPending(true);
    setFailed(false);

    const result = await authClient.signIn.social({
      callbackURL: `${window.location.origin}/`,
      provider: "github",
    });

    // Success redirects to GitHub; only a refusal returns control here.
    if (result.error) {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <main className="relative flex h-dvh w-full items-center justify-center overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,currentColor,transparent_60%)] opacity-[0.06]"
      />
      <ClientOnly>
        <Suspense>
          <PixelField className="absolute inset-0 size-full invert opacity-50 dark:invert-0 dark:opacity-70" />
        </Suspense>
      </ClientOnly>
      <div className="relative z-1 flex flex-col items-center gap-8 px-6 text-center">
        <h1 className="flex items-center gap-3 font-mono font-semibold text-3xl tracking-tight sm:text-4xl">
          <Logo className="size-9 sm:size-11" />
          cloud-swe
        </h1>
        <Button
          className="bg-foreground text-background hover:bg-foreground/90"
          disabled={pending}
          onClick={handleSignIn}
          size="lg"
          type="button"
        >
          {pending ? <Spinner data-icon="inline-start" /> : <GithubIcon data-icon="inline-start" />}
          Sign in with GitHub
        </Button>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {failed ? "Sign in could not start. Check that the API is reachable and try again." : ""}
        </p>
      </div>
    </main>
  );
}
