"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { GithubIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

// Loaded only for the signed-out landing, never for chat or onboarding.
const PixelField = dynamic(
  () => import("@/components/landing/pixel-field").then((module) => module.PixelField),
  { ssr: false },
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
    <main className="relative flex h-dvh w-full items-center justify-center overflow-hidden bg-neutral-950 text-neutral-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgb(255_255_255/0.06),transparent_60%)]"
      />
      <PixelField className="absolute inset-0 size-full opacity-70" />
      <div className="relative z-1 flex flex-col items-center gap-8 px-6 text-center">
        <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">cloud-swe</h1>
        <Button
          className="bg-neutral-50 text-neutral-900 hover:bg-neutral-200"
          disabled={pending}
          onClick={handleSignIn}
          size="lg"
          type="button"
        >
          {pending ? <Spinner data-icon="inline-start" /> : <GithubIcon data-icon="inline-start" />}
          Sign in with GitHub
        </Button>
        <p aria-live="polite" className="text-neutral-400 text-sm">
          {failed ? "Sign in could not start. Check that the API is reachable and try again." : ""}
        </p>
      </div>
    </main>
  );
}
