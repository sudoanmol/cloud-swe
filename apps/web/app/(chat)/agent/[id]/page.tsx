import { ThreadPage } from "@/components/chat/thread-view";

/**
 * `/agent/[id]` reads its id on the client, so the segment holds no request
 * data and client navigations render it from the prefetch without a server
 * round trip.
 */
export default function Page() {
  return <ThreadPage />;
}
