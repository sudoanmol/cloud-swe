import { ThreadPage } from "@/components/chat/chat-pages";

/** `/chat/[id]` renders inside the product shell from the route-group layout. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return <ThreadPage threadId={id} />;
}
