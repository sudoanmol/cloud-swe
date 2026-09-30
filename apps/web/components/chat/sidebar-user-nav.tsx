"use client";

import { ChevronUp } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useCallback } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { clearAccountStorage } from "@/lib/account-storage";
import { authClient, type SessionUser } from "@/lib/auth-client";

function emailToHue(email: string): number {
  let hash = 0;

  for (const char of email) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }

  return Math.abs(hash) % 360;
}

export function SidebarUserNav({ user }: { user: SessionUser }) {
  const { data, isPending } = authClient.useSession();
  const { setTheme, theme } = useTheme();
  const email = data?.user.email ?? user.email;

  const handleSignOut = useCallback(async () => {
    const result = await authClient.signOut();

    if (result.error) return;

    // Clear this account's persisted drafts, envelopes and model selection
    // before navigating: the full reload would otherwise rehydrate them.
    clearAccountStorage(user.id, window.sessionStorage, window.localStorage);

    // The gate reacts to the session change and returns to the landing.
    window.location.assign("/");
  }, [user.id]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="h-8 px-2 rounded-lg bg-transparent text-sidebar-foreground/70 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              data-testid="user-nav-button"
              aria-busy={isPending}
            >
              <div
                className="size-5 shrink-0 rounded-full ring-1 ring-sidebar-border/50"
                style={{
                  background: `linear-gradient(135deg, oklch(0.35 0.08 ${emailToHue(email)}), oklch(0.25 0.05 ${emailToHue(email) + 40}))`,
                }}
              />
              <span className="truncate text-[13px]" data-testid="user-email">
                {email}
              </span>
              <ChevronUp className="ml-auto size-3.5 text-sidebar-foreground/50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width) rounded-lg border border-border/60 bg-card/95 backdrop-blur-xl shadow-[var(--shadow-float)]"
            data-testid="user-nav-menu"
            side="top"
          >
            <DropdownMenuItem asChild>
              <Link className="cursor-pointer text-[13px]" href="/settings">
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup onValueChange={setTheme} value={theme ?? "system"}>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild data-testid="user-nav-item-auth">
              <button
                className="w-full cursor-pointer text-[13px]"
                onClick={() => {
                  void handleSignOut();
                }}
                type="button"
              >
                Sign out
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
