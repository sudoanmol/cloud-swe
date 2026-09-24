"use client";

import { Spinner } from "@/components/ui/spinner";
import { NewThreadView } from "@/components/chat/new-thread-view";
import { ThreadView } from "@/components/chat/thread-view";
import { authClient } from "@/lib/auth-client";

export function NewThreadPage() {
  const { data, isPending } = authClient.useSession();

  if (!data?.user) return isPending ? <Spinner /> : null;

  return <NewThreadView key={data.user.id} userId={data.user.id} />;
}

export function ThreadPage({ threadId }: { threadId: string }) {
  const { data, isPending } = authClient.useSession();

  if (!data?.user) return isPending ? <Spinner /> : null;

  return (
    <ThreadView key={`${data.user.id}:${threadId}`} threadId={threadId} userId={data.user.id} />
  );
}
