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
} from "@/components/app-shell";
import { LabeledField, TextInput, Select, Toggle, ACCENT } from "@/components/ui/primitives";
import { Save, Info } from "lucide-react";
import { api } from "@/lib/client/api";
import type { DropdownOption } from "@/lib/client/types";

type RateLimits = {
  loginWindowMin: number;
  loginMaxAttempts: number;
  loginLockAfterFails: number;
  ticketCreateWindowMin: number;
  ticketCreateMax: number;
  ticketCreateMaxUnauthenticated: number;
  globalPerMin: number;
  webhookPerMin: number;
};

type EmailSettings = {
  autoTicketPriority: string;
  autoTicketStatus: string;
  autoTicketMode: string;
  autoTicketServicesGroup: string;
  sendAutoAcknowledgement: boolean;
  notifyTechnicianOnInbound: boolean;
};

type Settings = {
  ticketNumberPattern: string;
  ticketPrefix: string;
  seqPadLength: number;
  resetSeqPerDay: boolean;
  patternVersion: number;
  pauseSlaOnScheduled: boolean;
  defaultTechnicianAssignment: string;
  sessionTimeoutMin: number;
  rateLimits: RateLimits;
  slaDefaults: Record<string, number>;
  email: EmailSettings;
};

/** Token palette for the pattern builder. */
const TOKENS = [
  { token: "{PREFIX}", label: "Prefix", example: "DSI" },
  { token: "{YYYY}", label: "Year (4)", example: "2026" },
  { token: "{YY}", label: "Year (2)", example: "26" },
  { token: "{MM}", label: "Month", example: "10" },
  { token: "{DD}", label: "Day", example: "06" },
  { token: "{SEQ}", label: "Sequence", example: "001" },
  { token: "{SEQ:4}", label: "Sequence (4)", example: "0001" },
];

export default function SettingsConfigPage() {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [options, setOptions] = React.useState<Record<string, DropdownOption[]>>({});
  const [preview, setPreview] = React.useState<{ next: string; current: string; dateKey: string } | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Local editable copy so typing never fights the server state.
  const [form, setForm] = React.useState<Settings | null>(null);
  const [livePreview, setLivePreview] = React.useState("");

  React.useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [settingsResponse, dropdowns, previewResponse] = await Promise.all([
          api.get<{ settings: Settings }>("/api/settings"),
          api.get<{ grouped: Record<string, DropdownOption[]> }>("/api/dropdowns"),
          api.get<{ next: string; current: string; dateKey: string }>("/api/settings?preview=1"),
        ]);
        setSettings(settingsResponse.settings);
        setForm(settingsResponse.settings);
        setOptions(dropdowns.grouped ?? {});
        setPreview(previewResponse);
        setError(null);
      } catch (caught) {
        setError(caught);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  /**
   * Live preview of the pattern without a round trip.
   * Mirrors renderTicketNumber() on the server; the authoritative value is the
   * one returned by /api/settings?preview=1 after saving.
   */
  React.useEffect(() => {
    if (!form) return;
    const parts = buildParts();
    const seqPad = form.seqPadLength;
    setLivePreview(
      form.ticketNumberPattern.replace(
        /\{(PREFIX|YYYY|YY|MM|DD|SEQ)(?::(\d+))?\}/gi,
        (_match, token: string, padArg?: string) => {
          switch (token.toUpperCase()) {
            case "PREFIX":
              return form.ticketPrefix;
            case "YYYY":
              return parts.year;
            case "YY":
              return parts.year2;
            case "MM":
              return parts.month;
            case "DD":
              return parts.day;
            case "SEQ": {
              const width = padArg ? Number(padArg) : seqPad;
              return String(parts.nextSeq).padStart(width, "0");
            }
            default:
              return "";
          }
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.ticketNumberPattern, form?.ticketPrefix, form?.seqPadLength, preview]);

  function buildParts() {
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const nextSeq = preview ? Number(preview.current.split(/[-/]/).pop() ?? "0") + 1 : 1;
    return {
      year: String(now.getUTCFullYear()),
      year2: String(now.getUTCFullYear()).slice(-2),
      month: String(now.getUTCMonth() + 1).padStart(2, "0"),
      day: String(now.getUTCDate()).padStart(2, "0"),
      nextSeq: Number.isFinite(nextSeq) ? nextSeq : 1,
    };
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.patch<{ settings: Settings }>("/api/settings", {
        ticketNumberPattern: form.ticketNumberPattern,
        ticketPrefix: form.ticketPrefix,
        seqPadLength: form.seqPadLength,
        resetSeqPerDay: form.resetSeqPerDay,
        pauseSlaOnScheduled: form.pauseSlaOnScheduled,
        defaultTechnicianAssignment: form.defaultTechnicianAssignment,
        sessionTimeoutMin: form.sessionTimeoutMin,
        rateLimits: form.rateLimits,
        slaDefaults: form.slaDefaults,
        email: form.email,
      });
      setSettings(response.settings);
      setForm(response.settings);
      const fresh = await api.get<{ next: string; current: string; dateKey: string }>(
        "/api/settings?preview=1",
      );
      setPreview(fresh);
      setNotice("Settings saved. They apply immediately — no redeploy needed.");
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  const hasSeqToken = /\{SEQ(?::\d+)?\}/i.test(form?.ticketNumberPattern ?? "");

  return (
    <AppPage
      actions={
        <PrimaryButton icon={Save} onClick={save} disabled={saving || !form}>
          {saving ? "Saving…" : "Save Settings"}
        </PrimaryButton>
      }
    >
      <PageHeading
        title="Settings"
        description="Ticket numbering, SLA, email intake and rate limits. Every value is read live, so changes take effect without a redeploy."
      />

      {loading || !form ? (
        <p className="py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
          Loading settings…
        </p>
      ) : (
        <div className="space-y-4">
          <ErrorNote error={error} />
          {notice ? <AlertBanner tone="success" title="Saved">{notice}</AlertBanner> : null}

          {/* ── Ticket numbering ─────────────────────────────────────────── */}
          <Panel
            title="Ticket Numbering"
            hint={`pattern version ${settings?.patternVersion ?? 1}`}
          >
            <div className="space-y-4 p-4">
              <div className="grid gap-3 lg:grid-cols-2">
                <LabeledField label="Prefix" required>
                  <TextInput
                    value={form.ticketPrefix}
                    onChange={(event) =>
                      setForm({ ...form, ticketPrefix: event.target.value.toUpperCase() })
                    }
                    className="uppercase"
                  />
                </LabeledField>

                <LabeledField label="Sequence Padding" hint="digits when no {SEQ:N}">
                  <TextInput
                    type="number"
                    min={1}
                    max={10}
                    value={form.seqPadLength}
                    onChange={(event) =>
                      setForm({ ...form, seqPadLength: Number(event.target.value) })
                    }
                  />
                </LabeledField>
              </div>

              <div>
                <LabeledField
                  label="Pattern"
                  required
                  hint={hasSeqToken ? "valid" : "must contain {SEQ}"}
                >
                  <TextInput
                    value={form.ticketNumberPattern}
                    onChange={(event) =>
                      setForm({ ...form, ticketNumberPattern: event.target.value })
                    }
                    className="font-mono"
                  />
                </LabeledField>

                {/* Token palette: click to insert at the end of the pattern. */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {TOKENS.map((entry) => (
                    <button
                      key={entry.token}
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          ticketNumberPattern: `${form.ticketNumberPattern}${entry.token}`,
                        })
                      }
                      title={`Currently renders as ${entry.example}`}
                      className="rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
                    >
                      {entry.token}
                      <span className="ml-1.5 text-[9px] opacity-60">{entry.example}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Live preview */}
              <div
                className="rounded-lg border p-3.5"
                style={{ borderColor: `${ACCENT}44`, backgroundColor: `${ACCENT}0d` }}
              >
                <p className="mb-2 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                  <Info className="h-3 w-3" /> Live Preview
                </p>
                <p className="text-lg font-bold tracking-tight" style={{ color: ACCENT }}>
                  {livePreview || "—"}
                </p>
                <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground">
                  <p>
                    Last issued:{" "}
                    <span className="font-mono">{preview?.current ?? "none yet"}</span>
                  </p>
                  <p>
                    Next ticket:{" "}
                    <span className="font-mono">{preview?.next ?? "—"}</span>
                  </p>
                  <p>
                    Sequence key: <span className="font-mono">{preview?.dateKey ?? "—"}</span>{" "}
                    (Asia/Manila)
                  </p>
                </div>
              </div>

              <label className="flex items-center gap-2.5 text-[11px]">
                <Toggle
                  checked={form.resetSeqPerDay}
                  onChange={(next) => setForm({ ...form, resetSeqPerDay: next })}
                  label="Reset the sequence every day"
                />
                <span>
                  <span className="font-medium">Reset sequence daily</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Off means one continuous sequence that never resets.
                  </span>
                </span>
              </label>

              <AlertBanner tone="info" title="Existing numbers are never rewritten">
                Changing the pattern bumps the pattern version, which is stamped onto every new
                ticket. Tickets created under an older pattern keep their original number so your
                history stays consistent.
              </AlertBanner>
            </div>
          </Panel>

          {/* ── SLA + assignment ────────────────────────────────────────── */}
          <Panel title="SLA & Assignment">
            <div className="space-y-4 p-4">
              <label className="flex items-center gap-2.5 text-[11px]">
                <Toggle
                  checked={form.pauseSlaOnScheduled}
                  onChange={(next) => setForm({ ...form, pauseSlaOnScheduled: next })}
                  label="Pause the SLA clock while a ticket is Scheduled"
                />
                <span>
                  <span className="font-medium">Pause SLA on Scheduled</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Freezes the countdown while a ticket waits for its scheduled date.
                  </span>
                </span>
              </label>

              <LabeledField label="Default Technician Assignment">
                <Select
                  value={form.defaultTechnicianAssignment}
                  onChange={(event) =>
                    setForm({ ...form, defaultTechnicianAssignment: event.target.value })
                  }
                >
                  <option value="self">Assign to the creator</option>
                  <option value="round-robin">Round robin across agents</option>
                  <option value="unassigned">Leave unassigned</option>
                </Select>
              </LabeledField>

              <LabeledField label="Session Timeout (minutes)" hint="also the idle timeout">
                <TextInput
                  type="number"
                  min={5}
                  value={form.sessionTimeoutMin}
                  onChange={(event) =>
                    setForm({ ...form, sessionTimeoutMin: Number(event.target.value) })
                  }
                />
              </LabeledField>

              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                  SLA Hours Override by Priority
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {(options.priority ?? []).map((option) => (
                    <LabeledField
                      key={option.value}
                      label={option.label}
                      hint={option.slaHours ? `default ${option.slaHours}h` : undefined}
                    >
                      <TextInput
                        type="number"
                        min={0}
                        step={0.5}
                        value={form.slaDefaults[option.value] ?? option.slaHours ?? 24}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            slaDefaults: {
                              ...form.slaDefaults,
                              [option.value]: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </LabeledField>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          {/* ── Email intake ────────────────────────────────────────────── */}
          <Panel title="Email Intake Defaults">
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <LabeledField label="Priority for auto-created tickets">
                <Select
                  value={form.email.autoTicketPriority}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      email: { ...form.email, autoTicketPriority: event.target.value },
                    })
                  }
                >
                  {(options.priority ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </LabeledField>

              <LabeledField label="Status for auto-created tickets">
                <Select
                  value={form.email.autoTicketStatus}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      email: { ...form.email, autoTicketStatus: event.target.value },
                    })
                  }
                >
                  {(options.status ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </LabeledField>

              <LabeledField label="Mode for email tickets">
                <Select
                  value={form.email.autoTicketMode}
                  onChange={(event) =>
                    setForm({ ...form, email: { ...form.email, autoTicketMode: event.target.value } })
                  }
                >
                  {(options.mode ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </LabeledField>

              <LabeledField label="Services Group for email tickets">
                <Select
                  value={form.email.autoTicketServicesGroup}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      email: { ...form.email, autoTicketServicesGroup: event.target.value },
                    })
                  }
                >
                  <option value="">— None —</option>
                  {(options.servicesGroup ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </LabeledField>

              <label className="flex items-center gap-2.5 text-[11px]">
                <Toggle
                  checked={form.email.sendAutoAcknowledgement}
                  onChange={(next) =>
                    setForm({ ...form, email: { ...form.email, sendAutoAcknowledgement: next } })
                  }
                  label="Send an auto-acknowledgement"
                />
                <span>
                  <span className="font-medium">Send auto-acknowledgement</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Replies to that email thread back onto the ticket automatically.
                  </span>
                </span>
              </label>

              <label className="flex items-center gap-2.5 text-[11px]">
                <Toggle
                  checked={form.email.notifyTechnicianOnInbound}
                  onChange={(next) =>
                    setForm({ ...form, email: { ...form.email, notifyTechnicianOnInbound: next } })
                  }
                  label="Notify the assigned technician on inbound mail"
                />
                <span>
                  <span className="font-medium">Notify technician</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Emails the assignee when a new reply lands.
                  </span>
                </span>
              </label>
            </div>
          </Panel>

          {/* ── Rate limits ─────────────────────────────────────────────── */}
          <Panel title="Rate Limits" hint="read live — no redeploy required">
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <LabeledField label="Login Window (minutes)">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.loginWindowMin}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: { ...form.rateLimits, loginWindowMin: Number(event.target.value) },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Login Max Attempts">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.loginMaxAttempts}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: { ...form.rateLimits, loginMaxAttempts: Number(event.target.value) },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Lock Account After Fails">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.loginLockAfterFails}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: {
                        ...form.rateLimits,
                        loginLockAfterFails: Number(event.target.value),
                      },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Global API (per minute)">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.globalPerMin}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: { ...form.rateLimits, globalPerMin: Number(event.target.value) },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Ticket Create Window (minutes)">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.ticketCreateWindowMin}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: {
                        ...form.rateLimits,
                        ticketCreateWindowMin: Number(event.target.value),
                      },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Tickets Per User">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.ticketCreateMax}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: { ...form.rateLimits, ticketCreateMax: Number(event.target.value) },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Tickets Per Anonymous">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.ticketCreateMaxUnauthenticated}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: {
                        ...form.rateLimits,
                        ticketCreateMaxUnauthenticated: Number(event.target.value),
                      },
                    })
                  }
                />
              </LabeledField>

              <LabeledField label="Webhook (per minute)" hint="generous">
                <TextInput
                  type="number"
                  min={1}
                  value={form.rateLimits.webhookPerMin}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rateLimits: { ...form.rateLimits, webhookPerMin: Number(event.target.value) },
                    })
                  }
                />
              </LabeledField>
            </div>
          </Panel>

          <GhostButton icon={Save} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Settings"}
          </GhostButton>
        </div>
      )}
    </AppPage>
  );
}