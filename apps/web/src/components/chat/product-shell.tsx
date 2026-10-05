import { PanelLeftIcon } from "lucide-react";

import { AppSidebar } from "@/components/chat/app-sidebar";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { useOnboardingRepair } from "@/hooks/use-onboarding-repair";

/**
 * Header on the sidebar surface above the chat card. On desktop the sidebar
 * rail owns toggling, so the header toggle only exists for the mobile sheet.
 */
export function ChatHeader({ children }: { children?: React.ReactNode }) {
  const { toggleSidebar } = useSidebar();

  return (
    <header className="sticky top-0 flex h-14 shrink-0 items-center gap-2 bg-sidebar px-3">
      <Button
        aria-label="Toggle sidebar"
        className="md:hidden"
        onClick={toggleSidebar}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <PanelLeftIcon className="size-4" />
      </Button>
      {children}
    </header>
  );
}

/** The rounded content surface; `SidebarRail`'s hover outline traces its edge. */
export function ChatCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-tl-[12px] md:border-t md:border-l md:border-border/40">
      {children}
    </div>
  );
}

/**
 * Sidebar and chat shell shared by every product route. The session comes from
 * the server gate; GitHub readiness is rechecked in the background.
 */
export function ProductShell({
  children,
  defaultSidebarOpen,
}: {
  children?: React.ReactNode;
  defaultSidebarOpen: boolean;
}) {
  useOnboardingRepair();

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      {/* min-w-0: wide panel content (code lines, the file tree) must not widen the page. */}
      <SidebarInset className="min-w-0">{children}</SidebarInset>
    </SidebarProvider>
  );
}
