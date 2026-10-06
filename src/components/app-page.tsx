"use client";

import * as React from "react";
import { AppShell } from "@/components/app-shell";
import { useSession } from "@/contexts/SessionContext";
import { useShellCounts } from "@/app/(app)/layout";

/**
 * Page-level wrapper.
 *
 * Each page supplies its own top-bar controls; this handles the session guard,
 * the sidebar counters and the forced password-change redirect so no page has
 * to repeat that logic.
 */
export function AppPage({
  children,
  actions,
  search,
  onFiltersClick,
  activeFilterCount,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  onFiltersClick?: () => void;
  activeFilterCount?: number;
}) {
  const { user, loading } = useSession();
  const { openCount, gmailCard } = useShellCounts();

  if (loading || !user) return null;

  return (
    <AppShell
      user={user}
      openTicketCount={openCount}
      gmailCard={gmailCard}
      actions={actions}
      search={search}
      onFiltersClick={onFiltersClick}
      activeFilterCount={activeFilterCount}
    >
      {children}
    </AppShell>
  );
}