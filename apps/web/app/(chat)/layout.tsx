import { cookies } from "next/headers";
import { Suspense } from "react";

import { AppGate } from "@/components/auth/session-gate";
import { ProductShell } from "@/components/chat/product-shell";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="h-dvh w-full bg-sidebar" />}>
      <AppGate>
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
