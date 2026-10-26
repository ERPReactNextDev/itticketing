"use client";

import * as React from "react";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  ErrorNote,
  AlertBanner,
  GhostButton,
  PrimaryButton,
  EmptyState,
} from "@/components/app-shell";
import { LabeledField, TextInput, ACCENT } from "@/components/ui/primitives";
import { Plus, Check, X, Trash2, Pencil } from "lucide-react";
import { api } from "@/lib/client/api";
import type { PermissionKey, Role } from "@/lib/client/types";

/** Permission catalogue, mirroring src/lib/shared/permissions.ts. */
const PERMISSION_ROWS: Array<{ key: PermissionKey; label: string; hint: string }> = [
  { key: "manageUsers", label: "Manage Staff / Agents", hint: "Create, edit, suspend and reset login accounts" },
  { key: "manageRequestors", label: "Manage Requestors", hint: "Edit the employee directory and CSV import" },
  { key: "manageDropdowns", label: "Manage Dropdowns", hint: "Add, reorder and deactivate ticket field options" },
  { key: "manageSettings", label: "Manage Settings", hint: "Ticket numbering, SLA, email and rate limits" },
  { key: "manageRoles", label: "Manage Roles", hint: "Edit roles and this permission matrix" },
  { key: "viewDashboard", label: "View Dashboard", hint: "See aggregate stats and charts" },
  { key: "viewAllTickets", label: "View All Tickets", hint: "Bypass the assigned-only ticket filter" },
  { key: "viewAssignedOnly", label: "View Assigned Only", hint: "Limit lists to their own tickets" },
  { key: "createTicket", label: "Create Ticket", hint: "Open new tickets" },
  { key: "editAnyTicket", label: "Edit Any Ticket", hint: "Edit fields on tickets they do not own" },
  { key: "assignTechnician", label: "Assign Technician", hint: "Reassign the technician on a ticket" },
  { key: "changeStatus", label: "Change Status", hint: "Move between Pending / Scheduled / Ongoing" },
  { key: "closeTicket", label: "Close Ticket", hint: "Resolve a ticket (sets closedBy + dateClosed)" },
  { key: "reopenTicket", label: "Reopen Ticket", hint: "Reopen a resolved ticket (resumes SLA)" },
  { key: "deleteTicket", label: "Delete Ticket", hint: "Permanently remove tickets" },
  { key: "exportCsv", label: "Export CSV", hint: "Download ticket and requestor exports" },
  { key: "viewAuditLogs", label: "View Audit Logs", hint: "Read the immutable audit trail" },
  { key: "sendEmailReply", label: "Send Email Reply", hint: "Send outbound replies through Resend" },
];

type PermissionMap = Record<PermissionKey, boolean>;

export default function RolesConfigPage() {
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [savingRoleId, setSavingRoleId] = React.useState<string | null>(null);

  const [creating, setCreating] = React.useState(false);
  const [newRole, setNewRole] = React.useState({ name: "", description: "" });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ roles: Role[] }>("/api/roles?matrix=1");
      setRoles(response.roles);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    document.title = "Roles & Access — Help Desk";
  }, []);

  async function savePermissions(role: Role, permissions: PermissionMap) {
    setSavingRoleId(role.id);
    setError(null);
    try {
      await api.patch(`/api/roles?id=${role.id}`, { permissions });
      setNotice(`${role.name} updated.`);
      setTimeout(() => setNotice(null), 2500);
      await load();
    } catch (caught) {
      setError(caught);
      await load();
    } finally {
      setSavingRoleId(null);
    }
  }

  async function rename(role: Role, name: string, description: string) {
    setSavingRoleId(role.id);
    setError(null);
    try {
      await api.patch(`/api/roles?id=${role.id}`, { name, description });
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSavingRoleId(null);
    }
  }

  async function createRole(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.post("/api/roles", {
        name: newRole.name.trim(),
        description: newRole.description.trim(),
        permissions: {},
      });
      setCreating(false);
      setNewRole({ name: "", description: "" });
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  async function remove(role: Role) {
    if (!window.confirm(`Delete the "${role.name}" role?`)) return;
    setError(null);
    try {
      await api.delete(`/api/roles?id=${role.id}`);
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <AppPage
      actions={
        <PrimaryButton
          icon={Plus}
          onClick={() => setCreating((prev) => !prev)}
        >
          New Role
        </PrimaryButton>
      }
    >
      <PageHeading
        title="Roles & Access"
        description="Permission matrix. Toggling a checkbox takes effect on the next request — users do not need to sign out."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />
        {notice ? <AlertBanner tone="success" title="Saved">{notice}</AlertBanner> : null}

        {creating ? (
          <Panel title="Create Role">
            <form onSubmit={createRole} className="grid gap-3 p-4 sm:grid-cols-2">
              <LabeledField label="Role Name" required>
                <TextInput
                  required
                  value={newRole.name}
                  onChange={(event) => setNewRole((c) => ({ ...c, name: event.target.value }))}
                  placeholder="e.g. Shift Supervisor"
                />
              </LabeledField>
              <LabeledField label="Description">
                <TextInput
                  value={newRole.description}
                  onChange={(event) => setNewRole((c) => ({ ...c, description: event.target.value }))}
                />
              </LabeledField>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <GhostButton type="button" icon={X} onClick={() => setCreating(false)}>
                  Cancel
                </GhostButton>
                <PrimaryButton type="submit" icon={Check} disabled={!newRole.name.trim()}>
                  Create Role
                </PrimaryButton>
              </div>
            </form>
          </Panel>
        ) : null}

        {loading ? (
          <p className="py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
            Loading roles…
          </p>
        ) : roles.length === 0 ? (
          <EmptyState title="No roles configured" />
        ) : (
          roles.map((role) => (
            <RoleMatrix
              key={role.id}
              role={role}
              saving={savingRoleId === role.id}
              onSavePermissions={(permissions) => void savePermissions(role, permissions)}
              onRename={(name, description) => void rename(role, name, description)}
              onDelete={() => void remove(role)}
            />
          ))
        )}

        <AlertBanner tone="info" title="How the matrix is enforced">
          Every API route re-checks permissions server-side, so hiding a menu item is only cosmetic —
          the check that matters is in the route handler. SuperAdmin must keep Manage Roles and
          Manage Settings, otherwise the system could become permanently unadministrable.
        </AlertBanner>
      </div>
    </AppPage>
  );
}

function RoleMatrix({
  role,
  saving,
  onSavePermissions,
  onRename,
  onDelete,
}: {
  role: Role;
  saving: boolean;
  onSavePermissions: (permissions: PermissionMap) => void;
  onRename: (name: string, description: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = React.useState<PermissionMap>(role.permissions);
  const [editingMeta, setEditingMeta] = React.useState(false);
  const [name, setName] = React.useState(role.name);
  const [description, setDescription] = React.useState(role.description);

  React.useEffect(() => {
    setDraft(role.permissions);
    setName(role.name);
    setDescription(role.description);
  }, [role]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(role.permissions);

  return (
    <Panel
      title={role.name}
      hint={`${Object.values(draft).filter(Boolean).length} of ${PERMISSION_ROWS.length} permissions · ${role.userCount ?? 0} account(s)`}
      actions={
        <div className="flex items-center gap-2">
          {saving ? (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Saving…</span>
          ) : dirty ? (
            <PrimaryButton icon={Check} onClick={() => onSavePermissions(draft)}>
              Save
            </PrimaryButton>
          ) : null}
          <GhostButton icon={Pencil} onClick={() => setEditingMeta((prev) => !prev)}>
            {editingMeta ? "Close" : "Rename"}
          </GhostButton>
          {!role.isSystem ? (
            <GhostButton icon={Trash2} onClick={onDelete}>
              Delete
            </GhostButton>
          ) : (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              system
            </span>
          )}
        </div>
      }
    >
      {editingMeta ? (
        <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-2">
          <LabeledField label="Role Name" required>
            <TextInput value={name} onChange={(event) => setName(event.target.value)} />
          </LabeledField>
          <LabeledField label="Description">
            <TextInput
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </LabeledField>
          <div className="sm:col-span-2">
            <PrimaryButton
              icon={Check}
              disabled={!name.trim() || (name === role.name && description === role.description)}
              onClick={() => onRename(name.trim(), description.trim())}
            >
              Save Details
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <p className="border-b border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          {role.description || "No description."}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                Permission
              </th>
              <th className="px-4 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                Allows
              </th>
              <th className="w-20 px-4 py-2 text-right text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                Granted
              </th>
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ROWS.map((permission) => (
              <tr key={permission.key} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-2 text-[11px] font-medium">{permission.label}</td>
                <td className="px-4 py-2 text-[10px] text-muted-foreground">{permission.hint}</td>
                <td className="px-4 py-2 text-right">
                  <input
                    type="checkbox"
                    aria-label={`${role.name}: ${permission.label}`}
                    className="accent-[#f97316]"
                    checked={draft[permission.key] === true}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [permission.key]: event.target.checked,
                      }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
