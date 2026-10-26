"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Root entry point.
 *
 * Middleware already redirects unauthenticated visitors to /login, so this only
 * needs to send a signed-in user to the dashboard.
 */
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        Redirecting…
      </p>
    </div>
  );
}
