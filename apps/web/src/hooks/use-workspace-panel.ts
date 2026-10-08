import { useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import type { WorkspaceTab } from "@/components/chat/workspace-panel";

/** Open/tab/maximized state of the workspace side panel (a sheet on mobile). */
export function useWorkspacePanel() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // Null until the user picks a view; the panel then offers both.
  const [tab, setTab] = useState<WorkspaceTab | null>(null);
  const [maximized, setMaximized] = useState(false);

  const openTab = (next: WorkspaceTab) => {
    setTab(next);
    setOpen(true);
  };

  const toggleTab = (next: WorkspaceTab) => (open && tab === next ? setOpen(false) : openTab(next));

  // ⌥⌘B (Ctrl+Alt+B): the secondary side bar shortcut in VS Code and Cursor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.code !== "KeyB") return;
      event.preventDefault();
      setOpen((current) => !current);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return {
    isMobile,
    open,
    setOpen,
    tab,
    /** The tab the header highlights: none while the panel is closed. */
    visibleTab: open ? tab : null,
    // Maximized hides the chat but keeps it mounted, so its scroll and draft survive.
    maximized: maximized && open && !isMobile,
    toggleMaximized: () => setMaximized((value) => !value),
    openTab,
    toggleTab,
  };
}
