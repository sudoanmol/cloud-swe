import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  ScriptOnce,
} from "@tanstack/react-router";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { bootQueryOptions } from "@/lib/session";
import styles from "@/styles.css?url";

const LIGHT_THEME_COLOR = "hsl(0 0% 100%)";

const DARK_THEME_COLOR = "hsl(240deg 10% 3.92%)";

const THEME_COLOR_SCRIPT = `\
(function() {
  var html = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  function updateThemeColor() {
    var isDark = html.classList.contains('dark');
    meta.setAttribute('content', isDark ? '${DARK_THEME_COLOR}' : '${LIGHT_THEME_COLOR}');
  }
  var observer = new MutationObserver(updateThemeColor);
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  updateThemeColor();
})()`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  /**
   * One session read per document: SSR loads it into the query cache, which is
   * dehydrated to the client, so later navigations resolve from the cache. An
   * unreachable auth server is not cached, so the next navigation retries.
   */
  beforeLoad: async ({ context: { queryClient } }) => {
    const boot = await queryClient.ensureQueryData(bootQueryOptions);

    if (boot.session.status === "unavailable")
      queryClient.removeQueries({ queryKey: bootQueryOptions.queryKey });

    return { boot };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1" },
      { title: "cloud-swe" },
      {
        name: "description",
        content: "Cloud coding agent with durable threads and a Linux workspace per thread.",
      },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <ScriptOnce>{THEME_COLOR_SCRIPT}</ScriptOnce>
      </head>
      <body className="antialiased overscroll-none">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
