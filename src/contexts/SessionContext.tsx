"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import type { SessionUser } from "@/lib/client/types";

type SessionState = {
  user: SessionUser | null;
  loading: boolean;
  refresh: () => Promise<SessionUser | null>;
  setUser: (user: SessionUser | null) => void;
};

const SessionContext = React.createContext<SessionState | null>(null);

/**
 * Client-side session state.
 *
 * The httpOnly cookie is the actual source of truth; this only mirrors what the
 * signed-in user is, so the shell can hide menu items they cannot use. Every
 * API route re-validates independently, so tampering with this context cannot
 * grant access to anything.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();

  const refresh = React.useCallback(async () => {
    try {
      const response = await api.get<{ user: SessionUser | null }>("/api/auth/me");
      setUser(response.user);
      return response.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // A 401 from anywhere means the session expired; bounce to login once.
  React.useEffect(() => {
    function onUnauthorised() {
      setUser(null);
      router.replace("/login");
    }
    window.addEventListener("itd:unauthorised", onUnauthorised);
    return () => window.removeEventListener("itd:unauthorised", onUnauthorised);
  }, [router]);

  const value = React.useMemo<SessionState>(
    () => ({ user, loading, refresh, setUser }),
    [user, loading, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider.");
  return context;
}

/**
 * Convenience hook for pages that need a user and a permission check.
 * Returns null while loading so callers can render a skeleton.
 */
export function useUser(): SessionUser | null {
  return useSession().user;
}

/** True when the user holds at least one of the given permissions. */
export function usePermission(...permissions: Array<keyof SessionUser["permissions"]>): boolean {
  const user = useUser();
  if (!user) return false;
  return permissions.some((permission) => user.permissions[permission]);
}
