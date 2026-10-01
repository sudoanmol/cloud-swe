import { cookies } from "next/headers";
import { Suspense } from "react";

import { AppGate } from "@/components/auth/session-gate";
import { ProductShell } from "@/components/chat/product-shell";
import { Landing } from "@/components/landing";

/**
 * One layout for `/`, `/agent/[id]` and `/settings`. Client navigations between
 * them keep this layout, so the session gate and the shell run once per page
 * load rather than once per click.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="h-dvh w-full bg-sidebar" />}>
      <AppGate signedOut={<Landing />}>
        <SidebarShell>{children}</SidebarShell>
      </AppGate>
    </Suspense>
  );
}

async function SidebarShell({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();

  return (
    <ProductShell defaultSidebarOpen={cookieStore.get("sidebar_state")?.value === "true"}>
      {children}
    </ProductShell>
  );
}
