import { useCallback, useEffect, useRef } from "react";

import { useSessionUser } from "@/lib/session";

/**
 * Account-generation guard for async work.
 *
 * A handler that starts work for one account captures the account it began
 * under and checks it before writing state, navigating or touching a cache. The
 * keyed product subtree unmounts the UI on a switch; this guard stops late
 * replies from the previous account from acting on the new one — and stops a
 * reply from acting at all once its observer has unmounted.
 */
export function useAccountGuard(): (expected: string) => boolean {
  const user = useSessionUser();
  const currentUserId = useRef(user.id);
  const mounted = useRef(true);

  currentUserId.current = user.id;

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  return useCallback(
    (expected: string) => mounted.current && currentUserId.current === expected,
    [],
  );
}
