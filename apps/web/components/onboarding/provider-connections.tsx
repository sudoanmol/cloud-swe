"use client";

import type { DeviceLoginStatus, modelProviderSummarySchema } from "@cloud-swe/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccountGuard } from "@/lib/account-scope";
import { Spinner } from "@/components/ui/spinner";
import {
  deleteProviderMutation,
  deviceLoginQueryOptions,
  modelProvidersQueryOptions,
  saveProviderKeyMutation,
  startDeviceLoginMutation,
} from "@/lib/queries";
import { DeviceLoginDialog } from "./device-login-dialog";

type ProviderSummary = z.infer<typeof modelProviderSummarySchema>;

type ProviderConnectionsProps = { userId: string };

/**
 * Provider connection UI shared by onboarding and account settings. Connected
 * means the backend stored a credential; it is not a paid-entitlement claim.
 */
export function ProviderConnections({ userId }: ProviderConnectionsProps) {
  const queryClient = useQueryClient();
  const accountIsCurrent = useAccountGuard();
  const providers = useQuery(modelProvidersQueryOptions(userId));

  const refresh = useCallback(async () => {
    // A late reply from the previous account must not touch this cache.
    if (!accountIsCurrent(userId)) return;

    await queryClient.invalidateQueries({ queryKey: ["session", userId, "model-providers"] });
    // Completion eligibility depends on stored credentials.
    await queryClient.invalidateQueries({ queryKey: ["session", userId, "onboarding"] });
  }, [accountIsCurrent, queryClient, userId]);

  if (providers.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );

  if (providers.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Providers could not be loaded</AlertTitle>
        <AlertDescription>
          <Button
            onClick={() => {
              void providers.refetch();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-3">
      {providers.data.providers.map((provider) =>
        provider.authType === "oauth" ? (
          <DeviceLoginRow
            key={provider.id}
            onRefresh={refresh}
            provider={provider}
            userId={userId}
          />
        ) : (
          <ApiKeyRow key={provider.id} onRefresh={refresh} provider={provider} userId={userId} />
        ),
      )}
    </div>
  );
}

function ProviderHeader({ provider }: { provider: ProviderSummary }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-sm">{provider.name}</span>
        <span className="text-muted-foreground text-xs">
          {provider.authType === "oauth" ? "ChatGPT device login" : "API key"}
        </span>
      </div>
      <Badge variant={provider.connected ? "secondary" : "outline"}>
        {provider.connected ? "Connected" : "Not connected"}
      </Badge>
    </div>
  );
}

function ApiKeyRow({
  provider,
  userId,
  onRefresh,
}: {
  provider: ProviderSummary;
  userId: string;
  onRefresh: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const accountIsCurrent = useAccountGuard();
  // Failure feedback outlives the mutation entry, which is removed on
  // settlement so the key cannot linger in the mutation cache.
  const [failure, setFailure] = useState(false);
  const mutationKey = ["session", userId, "provider-credentials", provider.id];

  const save = useMutation({
    ...saveProviderKeyMutation(mutationKey),
    onMutate: () => {
      setFailure(false);
    },
    onSuccess: async () => {
      if (!accountIsCurrent(userId)) return;

      setApiKey("");
      save.reset();
      await onRefresh();
    },
    onError: () => {
      if (accountIsCurrent(userId)) setFailure(true);
      save.reset();
    },
  });

  const remove = useMutation({
    ...deleteProviderMutation(),
    onSuccess: () => onRefresh(),
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <ProviderHeader provider={provider} />

      {provider.connected ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">Credential stored on the server.</span>
          <Button
            disabled={remove.isPending}
            onClick={() => remove.mutate(provider.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <FieldGroup>
          <Field data-invalid={failure || undefined}>
            <FieldLabel htmlFor={`${provider.id}-key`}>{provider.name} API key</FieldLabel>
            <InputGroup>
              <InputGroupInput
                aria-invalid={failure || undefined}
                autoComplete="off"
                id={`${provider.id}-key`}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                type="password"
                value={apiKey}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  disabled={apiKey.trim().length === 0 || save.isPending}
                  onClick={() => save.mutate({ provider: provider.id, apiKey: apiKey.trim() })}
                  size="sm"
                >
                  {save.isPending ? <Spinner /> : <KeyRoundIcon />}
                  Connect
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>Sent once to the backend and encrypted at rest.</FieldDescription>
          </Field>
        </FieldGroup>
      )}

      {failure || remove.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Provider update failed</AlertTitle>
          <AlertDescription>The credential was not changed. Try again.</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function DeviceLoginRow({
  provider,
  userId,
  onRefresh,
}: {
  provider: ProviderSummary;
  userId: string;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const accountIsCurrent = useAccountGuard();

  const start = useMutation({
    ...startDeviceLoginMutation(),
    onSuccess: () => {
      if (accountIsCurrent(userId)) setOpen(true);
    },
  });

  const loginId = start.data?.id;

  // Polling continues through `starting` and `pending`; the query stops itself
  // once the login reaches a terminal state, and closing the dialog disables it.
  const poll = useQuery({
    ...deviceLoginQueryOptions(userId, loginId ?? "none"),
    enabled: open && loginId !== undefined,
  });

  const latest: DeviceLoginStatus | undefined = poll.data ?? start.data;

  useEffect(() => {
    if (latest?.status === "authorized") void onRefresh();
  }, [latest?.status, onRefresh]);

  const remove = useMutation({
    ...deleteProviderMutation(),
    onSuccess: () => onRefresh(),
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <ProviderHeader provider={provider} />

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {provider.connected ? "ChatGPT credential stored." : "Sign in with a device code."}
        </span>
        {provider.connected ? (
          <Button
            disabled={remove.isPending}
            onClick={() => remove.mutate(provider.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            Disconnect
          </Button>
        ) : (
          <Button
            disabled={start.isPending}
            onClick={() => start.mutate()}
            size="sm"
            type="button"
            variant="outline"
          >
            {start.isPending ? <Spinner data-icon="inline-start" /> : null}
            Connect ChatGPT
          </Button>
        )}
      </div>

      {start.isError || remove.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Provider update failed</AlertTitle>
          <AlertDescription>The credential was not changed. Try again.</AlertDescription>
        </Alert>
      ) : null}

      <DeviceLoginDialog
        onOpenChange={setOpen}
        onStartAgain={() => start.mutate()}
        open={open}
        starting={start.isPending && loginId === undefined}
        status={latest}
        statusError={poll.isError ? poll.error : start.error}
      />
    </div>
  );
}
