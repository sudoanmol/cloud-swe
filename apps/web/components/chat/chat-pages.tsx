"use client";

import { useSessionUser } from "@/components/auth/session-provider";
import { NewThreadView } from "@/components/chat/new-thread-view";
import { ThreadView } from "@/components/chat/thread-view";

export function NewThreadPage() {
  const user = useSessionUser();

  return <NewThreadView userId={user.id} />;
}

export function ThreadPage({ threadId }: { threadId: string }) {
  const user = useSessionUser();

  return <ThreadView key={threadId} threadId={threadId} userId={user.id} />;
}
