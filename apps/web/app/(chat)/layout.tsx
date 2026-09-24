import { cookies } from "next/headers";
import { Suspense } from "react";

import { AppGate } from "@/components/auth/session-gate";
import { ProductShell } from "@/components/chat/product-shell";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppGate>
      <Suspense fallback={<div className="h-dvh w-full bg-sidebar" />}>
        <SidebarShell>{children}</SidebarShell>
      </Suspense>
    </AppGate>
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
