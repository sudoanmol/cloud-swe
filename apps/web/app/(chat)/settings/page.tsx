"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";

import { useSessionUser } from "@/components/auth/session-provider";
import { ChatCard, ChatHeader } from "@/components/chat/product-shell";
import { GithubStep } from "@/components/onboarding/github-step";
import { ProviderConnections } from "@/components/onboarding/provider-connections";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { onboardingQueryOptions } from "@/lib/queries";

export default function SettingsPage() {
  const userId = useSessionUser().id;
  const onboarding = useQuery(onboardingQueryOptions(userId));

  return (
    <div className="flex h-dvh w-full min-w-0 flex-col bg-sidebar">
      <ChatHeader>
        <span className="font-medium text-sm">Settings</span>
      </ChatHeader>
      <ChatCard>
        <main
          className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain"
          data-testid="settings-scroll"
        >
          <div
            className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6"
            data-testid="settings-content"
          >
            <Button asChild className="mb-6" size="sm" variant="ghost">
              <Link href="/">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to chat
              </Link>
            </Button>
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage the connections used for new runs.
            </p>

            <div className="mt-8 flex flex-col gap-8">
              {onboarding.data ? (
                <GithubStep
                  checking={onboarding.isFetching}
                  github={onboarding.data.github}
                  onRecheck={() => void onboarding.refetch()}
                />
              ) : (
                <section>
                  <h2 className="font-medium">Connect GitHub</h2>
                  {onboarding.isError ? (
                    <Button
                      className="mt-3"
                      onClick={() => void onboarding.refetch()}
                      variant="outline"
                    >
                      Retry GitHub status
                    </Button>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">Checking GitHub access…</p>
                  )}
                </section>
              )}

              <Separator />

              <section className="flex flex-col gap-4">
                <header>
                  <h2 className="font-medium text-base">Model providers</h2>
                  <p className="text-sm text-muted-foreground">
                    Credentials are encrypted on the server and used for your runs only.
                  </p>
                </header>
                <ProviderConnections userId={userId} />
              </section>
            </div>
          </div>
        </main>
      </ChatCard>
    </div>
  );
}
