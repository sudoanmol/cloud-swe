import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/login` is a redirect, not a second login screen. */
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
