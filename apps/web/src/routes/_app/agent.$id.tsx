import { createFileRoute } from "@tanstack/react-router";

import { ThreadPage } from "@/components/chat/thread-view";

export const Route = createFileRoute("/_app/agent/$id")({
  component: AgentRoute,
});

function AgentRoute() {
  const { id } = Route.useParams();

  return <ThreadPage threadId={id} />;
}
