"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  ErrorNote,
  AlertBanner,
  GhostButton,
  PrimaryButton,
  TerminalBadge,
} from "@/components/app-shell";
import { LabeledField, TextInput, KeyValueRow } from "@/components/ui/primitives";
import { Check, LogOut } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import { formatDateTime } from "@/lib/shared/format";

export default function ProfilePage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <ProfileView />
    </React.Suspense>
  );
}

function ProfileView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, refresh, setUser } = useSession();

  const forceChange = searchParams?.get("force") === "1";
  const nextPath = searchParams?.get("next") ?? "/dashboard";

  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [sessionTimeout, setSessionTimeout] = React.useState<number | null>(null);

  React.useEffect(() => {
    document.title = "My Profile — Help Desk";
  }, []);

  React.useEffect(() => {
    api.get<{ settings: { sessionTimeoutMin: number } }>("/api/settings")
      .then((r) => setSessionTimeout(r.settings.sessionTimeoutMin))
      .catch(() => {});
  }, []);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (newPassword !== confirmPassword) {
      setError(new Error("The two new passwords do not match."));
      return;
    }

    setSaving(true);
    try {
      await api.post("/api/auth/change-password", {
        currentPassword,
        newPassword,
      });
      const refreshed = await refresh();
      if (refreshed) setUser({ ...refreshed, mustChangePassword: false });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("Password updated.");
      if (forceChange) {
        router.replace(nextPath);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    try {
      await api.post("/api/auth/logout");
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <AppPage>
      <PageHeading
        title="My Profile"
        description="Your account details and password."
      />

      <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
        {forceChange || user?.mustChangePassword ? (
          <div className="lg:col-span-2">
            <AlertBanner tone="warning" title="Password change required">
              Your account was created or reset by an administrator, so you must set a new password
              before continuing.
            </AlertBanner>
          </div>
        ) : null}

        <Panel title="Account">
          <div className="space-y-1 p-4">
            <KeyValueRow label="Name" value={user?.name ?? "—"} />
            <KeyValueRow label="Email" value={user?.email ?? "—"} />
            <KeyValueRow label="Employee ID" value={user?.employeeId || "—"} mono />
            <KeyValueRow label="Role" value={user?.roleName ?? "—"} />
            <KeyValueRow label="Department" value={user?.department || "—"} />
            <KeyValueRow label="Site" value={user?.site || "—"} />
            <KeyValueRow
              label="Last Sign-In"
              value={user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}
            />
            <KeyValueRow
              label="Session Expires"
              value={sessionTimeout ? `After ${sessionTimeout} minutes of inactivity` : "—"}
            />
            <div className="mt-3 flex items-center gap-2">
              <TerminalBadge label="Active" color="#22c55e" />
              {user?.mustChangePassword ? (
                <TerminalBadge label="Must change password" color="#eab308" />
              ) : null}
            </div>
          </div>
        </Panel>

        <Panel title="Change Password" hint={forceChange ? "required" : undefined}>
          <form onSubmit={changePassword} className="space-y-3 p-4">
            <ErrorNote error={error} />
            {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

            <LabeledField label="Current Password" required>
              <TextInput
                required
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </LabeledField>

            <LabeledField label="New Password" required hint="10+ chars, letter and number">
              <TextInput
                required
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </LabeledField>

            <LabeledField label="Confirm New Password" required>
              <TextInput
                required
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </LabeledField>

            <div className="flex justify-end">
              <PrimaryButton type="submit" icon={Check} disabled={saving}>
                {saving ? "Updating…" : "Update Password"}
              </PrimaryButton>
            </div>
          </form>
        </Panel>

        <Panel title="Sign Out" className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-[11px] text-muted-foreground">
              Ends this session immediately and clears the session cookie on this device.
            </p>
            <GhostButton icon={LogOut} onClick={logout}>
              Sign Out
            </GhostButton>
          </div>
        </Panel>
      </div>
    </AppPage>
  );
}