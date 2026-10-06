"use client";

import * as React from "react";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  TerminalBadge,
  ErrorNote,
  EmptyState,
  GhostButton,
  PrimaryButton,
  AlertBanner,
} from "@/components/app-shell";
import { LabeledField, TextInput, Select, ACCENT } from "@/components/ui/primitives";
import { UserPlus, Pencil, X, KeyRound, Check } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { Role, StaffUser } from "@/lib/client/types";
import { formatDateTime } from "@/lib/shared/format";

export default function StaffDirectoryPage() {
  const { user } = useSession();

  const [staff, setStaff] = React.useState<StaffUser[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [editing, setEditing] = React.useState<StaffUser | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [resetting, setResetting] = React.useState<StaffUser | null>(null);

  const canManage = user?.permissions.manageUsers;

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter) params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("pageSize", "25");
      const response = await api.get<{
        users: StaffUser[];
        total: number;
        totalPages: number;
      }>(`/api/users?${params}`);
      setStaff(response.users);
      setTotal(response.total);
      setTotalPages(response.totalPages);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, page]);

  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  React.useEffect(() => {
    void (async () => {
      try {
        const response = await api.get<{ roles: Role[] }>("/api/roles");
        setRoles(response.roles);
      } catch {
        setRoles([]);
      }
    })();
  }, []);

  async function toggleSuspended(account: StaffUser, next: boolean) {
    setError(null);
    try {
      if (next) {
        await api.delete(`/api/users/${account.id}`);
        setNotice(`${account.name} has been suspended. Their ticket history is preserved.`);
      } else {
        await api.patch(`/api/users/${account.id}`, { status: "active" });
        setNotice(`${account.name} has been reactivated.`);
      }
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <AppPage
      search={{ value: search, onChange: setSearch, placeholder: "Search name, email, employee ID" }}
      actions={
        canManage ? (
          <PrimaryButton icon={UserPlus} onClick={() => setCreating(true)}>
            Add Staff
          </PrimaryButton>
        ) : null
      }
    >
      <PageHeading
        title="Staff & Agents"
        badge={<TerminalBadge label="Login accounts" color={ACCENT} />}
        description="Accounts that can sign in to the ticketing system. These are distinct from the requestor directory, which holds the employees who raise tickets."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />
        {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

        {creating ? (
          <StaffForm
            title="Add Staff Account"
            roles={roles}
            onCancel={() => setCreating(false)}
            onSaved={async (temporaryPassword) => {
              setCreating(false);
              setNotice(
                temporaryPassword
                  ? `Account created. Temporary password: ${temporaryPassword} — the user must change it at first sign-in.`
                  : "Account created.",
              );
              await load();
            }}
          />
        ) : null}

        {editing ? (
          <StaffForm
            title={`Edit ${editing.name}`}
            account={editing}
            roles={roles}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        ) : null}

        {resetting ? (
          <ResetPasswordForm
            account={resetting}
            onCancel={() => setResetting(null)}
            onSaved={async () => {
              setResetting(null);
              setNotice(`${resetting.name}'s password has been reset. They must change it at next sign-in.`);
            }}
          />
        ) : null}

        <Panel title="Accounts" hint={`${total} account${total === 1 ? "" : "s"}`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Status
            </span>
            <Select
              className="h-8 w-40"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
          </div>

          {loading ? (
            <p className="px-4 py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
              Loading…
            </p>
          ) : staff.length === 0 ? (
            <EmptyState title="No accounts found" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left">
                <thead>
                  <tr className="border-b border-border">
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Department</Th>
                    <Th>Site</Th>
                    <Th>Status</Th>
                    <Th>Last Sign-In</Th>
                    {canManage ? <Th>Actions</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {staff.map((account) => (
                    <tr key={account.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2.5">
                        <span className="block font-medium">{account.name}</span>
                        {account.employeeId ? (
                          <span className="block font-mono text-[9px] text-muted-foreground">
                            {account.employeeId}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{account.email}</td>
                      <td className="px-3 py-2.5">
                        <TerminalBadge label={account.roleName} color="#8b5cf6" />
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{account.department || "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{account.site || "—"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <TerminalBadge
                            label={account.status}
                            color={account.status === "active" ? "#22c55e" : "#94a3b8"}
                          />
                          {account.locked ? <TerminalBadge label="locked" color="#ef4444" /> : null}
                          {account.mustChangePassword ? (
                            <TerminalBadge label="must reset" color="#eab308" />
                          ) : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-muted-foreground">
                        {account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "Never"}
                      </td>
                      {canManage ? (
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setEditing(account)}
                              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setResetting(account)}
                              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title="Reset password"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </button>
                            {account.id !== user?.id ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void toggleSuspended(account, account.status === "active")
                                }
                                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                title={account.status === "active" ? "Suspend" : "Reactivate"}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-3">
            <GhostButton disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </GhostButton>
            <span className="text-[10px] text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <GhostButton disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </GhostButton>
          </div>
        ) : null}
      </div>
    </AppPage>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
      {children}
    </th>
  );
}

function StaffForm({
  title,
  account,
  roles,
  onCancel,
  onSaved,
}: {
  title: string;
  account?: StaffUser;
  roles: Role[];
  onCancel: () => void;
  onSaved: (temporaryPassword?: string) => void | Promise<void>;
}) {
  const [form, setForm] = React.useState({
    name: account?.name ?? "",
    email: account?.email ?? "",
    employeeId: account?.employeeId ?? "",
    roleId: account?.roleId ?? "",
    department: account?.department ?? "",
    site: account?.site ?? "",
    position: account?.position ?? "",
    phone: account?.phone ?? "",
    status: account?.status ?? "active",
    password: "",
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (account) {
        await api.patch(`/api/users/${account.id}`, {
          name: form.name,
          email: form.email,
          employeeId: form.employeeId,
          roleId: form.roleId,
          department: form.department,
          site: form.site,
          position: form.position,
          phone: form.phone,
          status: form.status,
        });
        await onSaved();
      } else {
        const response = await api.post<{ temporaryPassword?: string }>("/api/users", {
          name: form.name,
          email: form.email,
          employeeId: form.employeeId,
          roleId: form.roleId,
          department: form.department,
          site: form.site,
          position: form.position,
          phone: form.phone,
          status: form.status,
          password: form.password || undefined,
        });
        await onSaved(response.temporaryPassword);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title={title}>
      <form onSubmit={submit} className="space-y-4 p-4">
        <ErrorNote error={error ? new Error(error) : null} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LabeledField label="Name" required>
            <TextInput required value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} />
          </LabeledField>
          <LabeledField label="Email" required>
            <TextInput
              required
              type="email"
              value={form.email}
              onChange={(e) => setForm((c) => ({ ...c, email: e.target.value }))}
            />
          </LabeledField>
          <LabeledField label="Employee ID">
            <TextInput value={form.employeeId} onChange={(e) => setForm((c) => ({ ...c, employeeId: e.target.value }))} />
          </LabeledField>
          <LabeledField label="Role" required>
            <Select required value={form.roleId} onChange={(e) => setForm((c) => ({ ...c, roleId: e.target.value }))}>
              <option value="">— Select —</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          </LabeledField>
          <LabeledField label="Department">
            <TextInput value={form.department} onChange={(e) => setForm((c) => ({ ...c, department: e.target.value }))} />
          </LabeledField>
          <LabeledField label="Site">
            <TextInput value={form.site} onChange={(e) => setForm((c) => ({ ...c, site: e.target.value }))} />
          </LabeledField>
          <LabeledField label="Position">
            <TextInput value={form.position} onChange={(e) => setForm((c) => ({ ...c, position: e.target.value }))} />
          </LabeledField>
          <LabeledField label="Phone">
            <TextInput value={form.phone} onChange={(e) => setForm((c) => ({ ...c, phone: e.target.value }))} />
          </LabeledField>
          {account ? (
            <LabeledField label="Status">
              <Select value={form.status} onChange={(e) => setForm((c) => ({ ...c, status: e.target.value }))}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </Select>
            </LabeledField>
          ) : (
            <LabeledField label="Password" hint="blank = auto-generate">
              <TextInput
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm((c) => ({ ...c, password: e.target.value }))}
                placeholder="Auto-generated"
              />
            </LabeledField>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onCancel}>
            Cancel
          </GhostButton>
          <PrimaryButton type="submit" icon={Check} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </PrimaryButton>
        </div>
      </form>
    </Panel>
  );
}

function ResetPasswordForm({
  account,
  onCancel,
  onSaved,
}: {
  account: StaffUser;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/auth/change-password", {
        targetUserId: account.id,
        newPassword: password,
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reset failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title={`Reset password for ${account.name}`}>
      <form onSubmit={submit} className="space-y-4 p-4">
        <ErrorNote error={error ? new Error(error) : null} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The new password must be at least 10 characters and contain a letter and a number. The
          account will be required to change it again at next sign-in.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledField label="New Password" required>
            <TextInput
              required
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </LabeledField>
          <LabeledField label="Confirm Password" required>
            <TextInput
              required
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </LabeledField>
        </div>
        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onCancel}>
            Cancel
          </GhostButton>
          <PrimaryButton type="submit" icon={Check} disabled={saving}>
            {saving ? "Resetting…" : "Reset Password"}
          </PrimaryButton>
        </div>
      </form>
    </Panel>
  );
}