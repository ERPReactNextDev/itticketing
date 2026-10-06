"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { TicketListResponse } from "@/lib/client/types";

/**
 * Authenticated app shell.
 *
 * Reads the session once, redirects to /login when there is none, and provides
 * the open-ticket count + Gmail intake count that the sidebar needs. Both come
 * from a single lightweight tickets request rather than the full dashboard.
 */
function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [openCount, setOpenCount] = React.useState<number | undefined>(undefined);
  const [gmailCard, setGmailCard] = React.useState<{ count: number; window: string }>();

  React.useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.mustChangePassword && !pathname?.startsWith("/profile")) {
      router.replace("/profile?force=1");
    }
  }, [loading, user, router, pathname]);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function loadCounts() {
      try {
        const list = await api.get<TicketListResponse>(
          "/api/tickets?openOnly=true&pageSize=1&sort=sla",
        );
        if (cancelled) return;
        setOpenCount(list.total);

        const dashboard = await api.get<{ totals: { inboundLast24h: number } }>(
          "/api/dashboard",
        );
        if (cancelled) return;
        setGmailCard({
          count: dashboard.totals.inboundLast24h,
          window: "last 24 hours",
        });
      } catch {
        // The sidebar is decoration; a failure here must not break the page.
      }
    }

    void loadCounts();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Loading…
        </p>
      </div>
    );
  }

  return (
    <ShellContext.Provider value={{ openCount, gmailCard }}>
      {children}
    </ShellContext.Provider>
  );
}

type ShellContextValue = {
  openCount?: number;
  gmailCard?: { count: number; window: string };
};

const ShellContext = React.createContext<ShellContextValue>({});

/** Sidebar counters, shared by every authenticated page. */
export function useShellCounts(): ShellContextValue {
  return React.useContext(ShellContext);
}

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  // SessionProvider lives in the root layout so the login page can use it too.
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}