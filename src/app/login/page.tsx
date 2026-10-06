"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { SessionUser } from "@/lib/client/types";
import { ACCENT } from "@/components/ui/primitives";

export default function LoginPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setUser } = useSession();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const nextPath = searchParams?.get("next") ?? "/dashboard";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await api.post<{ user: SessionUser }>("/api/auth/login", {
        email: email.trim().toLowerCase(),
        password,
      });
      setUser(response.user);

      // A seeded or admin-reset account must change its password before it
      // can reach the rest of the app.
      const destination = response.user.mustChangePassword
        ? `/profile?next=${encodeURIComponent(nextPath)}&force=1`
        : nextPath;

      router.replace(destination);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError("Unable to sign in right now. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl"
            style={{ backgroundColor: `${ACCENT}1f`, color: ACCENT }}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M4 13a8 8 0 0 1 16 0" strokeLinecap="round" />
              <rect x="2.5" y="13" width="4" height="6" rx="1.5" />
              <rect x="17.5" y="13" width="4" height="6" rx="1.5" />
            </svg>
          </div>
          <h1 className="text-lg font-bold uppercase tracking-wide text-foreground">Help Desk</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            IT Ticketing v2.0
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-border bg-card p-5 shadow-sm"
        >
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
            autoFocus
            className="mb-4 h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-accent"
            placeholder="you@company.com"
          />

          <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
            Password
          </label>
          <div className="relative mb-4">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="h-10 w-full rounded-md border border-border bg-background px-3 pr-16 text-sm outline-none transition-colors focus:border-accent"
              placeholder="••••••••"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>

          {error ? (
            <div
              className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="h-10 w-full rounded-md text-[11px] font-bold uppercase tracking-[0.15em] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: ACCENT }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          <p className="mt-4 text-center text-[10px] leading-relaxed text-muted-foreground">
            Accounts are created by your administrator. Contact them if you cannot sign in.
          </p>
        </form>
      </div>
    </div>
  );
}