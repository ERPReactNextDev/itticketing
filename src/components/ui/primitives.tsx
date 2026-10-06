"use client";

import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared design tokens, mirroring globals.css. */
export const ACCENT = "#f97316";

export const SLAB_BG = "#f8f8f6";
export const SLAB_BORDER = "#e7e5e4";

/** Uppercase monospace field label, used throughout the forms. */
export function FieldLabel({
  children,
  required,
  hint,
}: {
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {children}
        {required ? <span style={{ color: ACCENT }}> *</span> : null}
      </span>
      {hint ? <span className="text-[9px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function TextInput({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent disabled:opacity-60",
        className,
      )}
    />
  );
}

export function TextArea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent disabled:opacity-60",
        className,
      )}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cn(
        "h-9 w-full appearance-none rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors focus:border-accent disabled:opacity-60",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function LabeledField({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <FieldLabel required={required} hint={hint}>
        {label}
      </FieldLabel>
      {children}
    </div>
  );
}

/** Read-only display of an auto-populated field. */
export function AutoField({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/40 px-2.5 py-2">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          {label}
        </span>
        {badge ? (
          <span className="rounded bg-muted px-1 py-px text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
            {badge}
          </span>
        ) : null}
      </div>
      <p className="truncate text-[12px] font-medium text-foreground">{value || "—"}</p>
    </div>
  );
}

/** Toggle switch used by the dropdown configuration screen. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
        style={checked ? { transform: "translateX(18px)" } : undefined}
      />
    </button>
  );
}

export function KeyValueRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-[11px] text-foreground",
          mono && "tabular-nums",
        )}
      >
        {value || "—"}
      </span>
    </div>
  );
}

export type { LucideIcon };