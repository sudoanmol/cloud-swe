import { createFileRoute } from "@tanstack/react-router";

import { NewThreadPage } from "@/components/chat/new-thread-view";

/** `/`: a new agent inside the product shell; `_app` shows the landing when signed out. */
export const Route = createFileRoute("/_app/")({
  component: NewThreadPage,
});
