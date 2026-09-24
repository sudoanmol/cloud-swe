"use client";

import { Toaster } from "sonner";
import { PanelRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { AppSidebar } from "@/components/chat/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function RightSidebarPlaceholder() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className="ml-auto"
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open right sidebar"
          aria-disabled="true"
        >
          <PanelRightIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Coming soon</TooltipContent>
    </Tooltip>
  );
}

/**
 * Sidebar and chat shell shared by `/` and `/chat/[id]`. The session comes from
 * the Better Auth client, so no route needs a server-side auth read.
 */
export function ProductShell({
  children,
  defaultSidebarOpen,
}: {
  children?: React.ReactNode;
  defaultSidebarOpen: boolean;
}) {
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      <SidebarInset>
        <Toaster
          position="top-center"
          theme="system"
          toastOptions={{
            className: "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
          }}
        />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
