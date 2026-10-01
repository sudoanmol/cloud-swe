import { cookies } from "next/headers";
import { Suspense } from "react";

import { AppGate } from "@/components/auth/session-gate";
import { NewThreadPage } from "@/components/chat/chat-pages";
import { ProductShell } from "@/components/chat/product-shell";
import { Landing } from "@/components/landing";

/**
 * `/` is session-aware: the signed-out landing, the onboarding redirect, or the
 * new-thread chat shell. It sits outside the protected chat route group so the
 * landing never renders inside product chrome.
 */
export default function Page() {
  return (
    <Suspense fallback={<div className="h-dvh w-full bg-sidebar" />}>
      <AppGate signedOut={<Landing />}>
        <NewChatShell />
      </AppGate>
    </Suspense>
  );
}

async function NewChatShell() {
  const cookieStore = await cookies();

  return (
    <ProductShell defaultSidebarOpen={cookieStore.get("sidebar_state")?.value === "true"}>
      <NewThreadPage />
    </ProductShell>
  );
}
