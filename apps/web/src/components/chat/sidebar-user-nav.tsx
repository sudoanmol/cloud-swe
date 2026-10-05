import { ChevronUp } from "lucide-react";
import { useTheme } from "next-themes";
import { Link } from "@tanstack/react-router";
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

function hueFor(seed: string): number {
  let hash = 0;

  for (const char of seed) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }

  return Math.abs(hash) % 360;
}

export function SidebarUserNav({ user }: { user: SessionUser }) {
  const { setTheme, theme } = useTheme();
  // GitHub sign-in stores the profile name, or the login when no name is set.
  const displayName = user.name || user.email;

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
              className="h-8 px-2 group-data-[collapsible=icon]:p-1.5! rounded-lg bg-transparent text-sidebar-foreground/70 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              data-testid="user-nav-button"
            >
              {user.image ? (
                // GitHub sign-in stores the account's avatar URL.
                <img
                  alt=""
                  className="size-5 shrink-0 rounded-full object-cover ring-1 ring-sidebar-border/50"
                  src={user.image}
                />
              ) : (
                <div
                  className="size-5 shrink-0 rounded-full ring-1 ring-sidebar-border/50"
                  style={{
                    background: `linear-gradient(135deg, oklch(0.35 0.08 ${hueFor(user.email)}), oklch(0.25 0.05 ${hueFor(user.email) + 40}))`,
                  }}
                />
              )}
              <span className="truncate">{displayName}</span>
              <ChevronUp className="ml-auto size-3.5 text-sidebar-foreground/50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width) rounded-lg border border-border/60 bg-card/95 backdrop-blur-xl shadow-[var(--shadow-float)]"
            data-testid="user-nav-menu"
            side="top"
          >
            <DropdownMenuItem asChild className="text-[13px]">
              <Link to="/settings">Settings</Link>
            </DropdownMenuItem>
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup onValueChange={setTheme} value={theme ?? "system"}>
              <DropdownMenuRadioItem className="text-[13px]" value="system">
                System
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem className="text-[13px]" value="light">
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem className="text-[13px]" value="dark">
                Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[13px]" onSelect={() => void handleSignOut()}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
