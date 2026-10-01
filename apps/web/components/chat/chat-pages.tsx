"use client";

import { useParams } from "next/navigation";

import { useSessionUser } from "@/components/auth/session-provider";
import { NewThreadView } from "@/components/chat/new-thread-view";
import { ThreadView } from "@/components/chat/thread-view";

export function NewThreadPage() {
  const user = useSessionUser();

  return <NewThreadView userId={user.id} />;
}

export function ThreadPage() {
  const user = useSessionUser();
  const { id: threadId } = useParams<{ id: string }>();

  return <ThreadView key={threadId} threadId={threadId} userId={user.id} />;
}
