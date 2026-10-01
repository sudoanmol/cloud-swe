"use client";

import { createContext, useContext } from "react";

import type { SessionUser } from "@/lib/auth-client";

const SessionContext = createContext<SessionUser | null>(null);

/**
 * The signed-in user read by the server gate. Signing in or out is a full page
 * load, so the user is fixed for the lifetime of the rendered product tree.
 */
export function SessionProvider({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  return <SessionContext value={user}>{children}</SessionContext>;
}

export function useSessionUser(): SessionUser {
  const user = useContext(SessionContext);

  if (!user) throw new Error("useSessionUser must be used inside the session gate");

  return user;
}
