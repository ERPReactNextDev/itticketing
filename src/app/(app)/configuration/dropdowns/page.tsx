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
import { LabeledField, TextInput, Toggle, ACCENT } from "@/components/ui/primitives";
import { Plus, Pencil, GripVertical, Trash2, Check, X, RotateCcw } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { DropdownOption } from "@/lib/client/types";
import { cn } from "@/lib/utils";

/** Tab per dropdown type, matching the seeded option lists. */
const TABS: Array<{ type: string; label: string }> = [
  { type: "department", label: "Department" },
  { type: "requestType", label: "Request Type" },
  { type: "typeOfConcern", label: "Type of Concern" },
  { type: "mode", label: "Mode" },
  { type: "servicesGroup", label: "Services Group" },
  { type: "site", label: "Site" },
  { type: "status", label: "Status" },
  { type: "priority", label: "Priority · SLA" },
];

export default function DropdownsConfigPage() {
  const { user } = useSession();
  const canManage = user?.permissions.manageDropdowns;

  const [options, setOptions] = React.useState<DropdownOption[]>([]);
  const [activeTab, setActiveTab] = React.useState(TABS[0].type);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [usageWarning, setUsageWarning] = React.useState<string | null>(null);

  const [draft, setDraft] = React.useState<Partial<DropdownOption> | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    document.title = "Configuration — Help Desk";
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ options: DropdownOption[] }>(
        "/api/dropdowns?includeInactive=1",
      );
      setOptions(response.options);
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

  const visible = React.useMemo(
    () => options.filter((option) => option.type === activeTab),
    [options, activeTab],
  );

  /** Drag-and-drop reorder; falls back to the arrow controls on touch. */
  async function reorder(next: DropdownOption[]) {
    setOptions((current) =>
      current.map((option) => {
        const index = next.findIndex((entry) => entry.id === option.id);
        return index === -1 ? option : { ...option, order: index };
      }),
    );
    try {
      await api.put("/api/dropdowns", { type: activeTab, ids: next.map((o) => o.id) });
    } catch (caught) {
      setError(caught);
      void load();
    }
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...visible];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void reorder(next);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setUsageWarning(null);
    try {
      await api.post("/api/dropdowns", {
        id: draft.id,
        type: activeTab,
        label: draft.label,
        value: draft.value,
        slaHours: draft.slaHours,
        color: draft.color,
        order: draft.order,
      });
      setDraft(null);
      setCreating(false);
      setNotice("Saved.");
      setTimeout(() => setNotice(null), 2500);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(option: DropdownOption, next: boolean) {
    setError(null);
    try {
      await api.patch(`/api/dropdowns?id=${option.id}`, { active: next });
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  async function remove(option: DropdownOption) {
    if (!window.confirm(`Delete "${option.label}"?`)) return;
    setError(null);
    setUsageWarning(null);
    try {
      await api.delete(`/api/dropdowns?id=${option.id}`);
      await load();
    } catch (caught) {
      setUsageWarning(caught instanceof Error ? caught.message : "Could not delete.");
    }
  }

  const isPriority = activeTab === "priority";
  const hasColour = activeTab === "priority" || activeTab === "status";

  return (
    <AppPage>
      <PageHeading
        title="Configuration"
        badge={<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">SuperAdmin</span>}
        description="Every option here is editable. Changes apply to new tickets only — existing tickets keep the values they were created with."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />
        {usageWarning ? <AlertBanner tone="warning" title="Cannot delete">{usageWarning}</AlertBanner> : null}
        {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

        {/* Type tabs */}
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => {
            const count = options.filter((option) => option.type === tab.type).length;
            const active = activeTab === tab.type;
            return (
              <button
                key={tab.type}
                type="button"
                onClick={() => {
                  setActiveTab(tab.type);
                  setDraft(null);
                  setCreating(false);
                }}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
                  active
                    ? "border-transparent text-white"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                style={active ? { backgroundColor: ACCENT } : undefined}
              >
                {tab.label}
                <span className="ml-1.5 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>

        <Panel
          title={`${TABS.find((tab) => tab.type === activeTab)?.label} Options`}
          hint={`${visible.length} option${visible.length === 1 ? "" : "s"}`}
          actions={
            <div className="flex items-center gap-2">
              <GhostButton icon={RotateCcw} onClick={() => void load()}>Reload</GhostButton>
              {canManage ? (
                <PrimaryButton
                  icon={Plus}
                  onClick={() => {
                    setCreating(true);
                    setDraft({ type: activeTab, label: "", value: "", order: visible.length });
                  }}
                >
                  Add Option
                </PrimaryButton>
              ) : null}
            </div>
          }
        >
          {loading ? (
            <p className="px-4 py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
              Loading…
            </p>
          ) : visible.length === 0 && !creating ? (
            <EmptyState
              title="No options"
              description="Add the first option to make this field selectable on new tickets."
            />
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((option, index) => {
                const editing = draft?.id === option.id;
                return (
                  <li key={option.id} className="px-4 py-2.5">
                    {editing ? (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <LabeledField label="Label" required>
                          <TextInput
                            value={draft?.label ?? ""}
                            onChange={(event) =>
                              setDraft((current) => ({ ...current, label: event.target.value }))
                            }
                            autoFocus
                          />
                        </LabeledField>
                        <LabeledField label="Value" hint="stable slug">
                          <TextInput
                            value={draft?.value ?? ""}
                            onChange={(event) =>
                              setDraft((current) => ({ ...current, value: event.target.value }))
                            }
                          />
                        </LabeledField>
                        {isPriority ? (
                          <LabeledField label="SLA Hours" required>
                            <TextInput
                              type="number"
                              min={0}
                              step={0.5}
                              value={draft?.slaHours ?? 24}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  slaHours: Number(event.target.value),
                                }))
                              }
                            />
                          </LabeledField>
                        ) : null}
                        {hasColour ? (
                          <LabeledField label="Colour">
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={draft?.color ?? "#f97316"}
                                onChange={(event) =>
                                  setDraft((current) => ({ ...current, color: event.target.value }))
                                }
                                className="h-9 w-12 rounded border border-border"
                              />
                              <TextInput
                                value={draft?.color ?? "#f97316"}
                                onChange={(event) =>
                                  setDraft((current) => ({ ...current, color: event.target.value }))
                                }
                                className="flex-1"
                              />
                            </div>
                          </LabeledField>
                        ) : null}
                        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
                          <PrimaryButton icon={Check} onClick={save} disabled={saving}>
                            {saving ? "Saving…" : "Save"}
                          </PrimaryButton>
                          <GhostButton
                            icon={X}
                            onClick={() => {
                              setDraft(null);
                              setCreating(false);
                            }}
                          >
                            Cancel
                          </GhostButton>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => move(index, -1)}
                            disabled={index === 0 || !canManage}
                            className="text-[8px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-30"
                            title="Move up"
                            aria-label={`Move ${option.label} up`}
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={() => move(index, 1)}
                            disabled={index === visible.length - 1 || !canManage}
                            className="text-[8px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-30"
                            title="Move down"
                            aria-label={`Move ${option.label} down`}
                          >
                            ▼
                          </button>
                        </span>

                        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

                        {hasColour ? (
                          <span
                            className="h-3 w-3 shrink-0 rounded-full"
                            style={{ backgroundColor: option.color ?? "#cbd5e1" }}
                          />
                        ) : null}

                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[12px]",
                            !option.active && "text-muted-foreground line-through",
                          )}
                        >
                          {option.label}
                        </span>

                        {isPriority ? (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
                            {option.slaHours ?? 0}h SLA
                          </span>
                        ) : null}

                        {!option.active ? (
                          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700">
                            inactive
                          </span>
                        ) : null}

                        {canManage ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Toggle
                              checked={option.active}
                              onChange={(next) => void toggle(option, next)}
                              label={`${option.active ? "Deactivate" : "Activate"} ${option.label}`}
                            />
                            <button
                              type="button"
                              onClick={() => setDraft({ ...option })}
                              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(option)}
                              className="rounded p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}

              {/* New option row */}
              {creating && !draft?.id ? (
                <li className="bg-muted/30 px-4 py-2.5">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <LabeledField label="Label" required>
                      <TextInput
                        value={draft?.label ?? ""}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, label: event.target.value }))
                        }
                        placeholder="New option"
                        autoFocus
                      />
                    </LabeledField>
                    <LabeledField label="Value" hint="auto if blank">
                      <TextInput
                        value={draft?.value ?? ""}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, value: event.target.value }))
                        }
                      />
                    </LabeledField>
                    {isPriority ? (
                      <LabeledField label="SLA Hours" required>
                        <TextInput
                          type="number"
                          min={0}
                          step={0.5}
                          value={draft?.slaHours ?? 24}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, slaHours: Number(event.target.value) }))
                          }
                        />
                      </LabeledField>
                    ) : null}
                    {hasColour ? (
                      <LabeledField label="Colour">
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={draft?.color ?? "#f97316"}
                            onChange={(event) =>
                              setDraft((current) => ({ ...current, color: event.target.value }))
                            }
                            className="h-9 w-12 rounded border border-border"
                          />
                          <TextInput
                            value={draft?.color ?? "#f97316"}
                            onChange={(event) =>
                              setDraft((current) => ({ ...current, color: event.target.value }))
                            }
                            className="flex-1"
                          />
                        </div>
                      </LabeledField>
                    ) : null}
                    <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
                      <PrimaryButton
                        icon={Check}
                        onClick={save}
                        disabled={saving || !draft?.label?.trim()}
                      >
                        {saving ? "Saving…" : "Add Option"}
                      </PrimaryButton>
                      <GhostButton icon={X} onClick={() => { setCreating(false); setDraft(null); }}>
                        Cancel
                      </GhostButton>
                    </div>
                  </div>
                </li>
              ) : null}
            </ul>
          )}
        </Panel>

        <AlertBanner tone="info" title="How deactivation works">
          Turning an option off removes it from new-ticket dropdowns. Existing tickets keep the value
          and display it as <strong>(inactive)</strong>, so historical records never go blank. Hard
          delete is only possible while no ticket references the option.
        </AlertBanner>
      </div>
    </AppPage>
  );
}
