"use client";

import * as React from "react";
import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight, Calendar, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCENT } from "@/components/ui/primitives";

import "react-day-picker/style.css";

/* ─── types ─────────────────────────────────────────────────────────────── */

export interface DateTimePickerProps {
  /** ISO string or undefined */
  value?: string;
  onChange: (iso: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Minimum selectable date (ISO or Date) */
  fromDate?: Date;
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Convert 24h hour → 12h hour (1–12) */
function to12h(h24: number): number {
  const h = h24 % 12;
  return h === 0 ? 12 : h;
}

/** Convert 12h hour + period → 24h hour */
function to24h(h12: number, period: "AM" | "PM"): number {
  if (period === "AM") return h12 === 12 ? 0 : h12;
  return h12 === 12 ? 12 : h12 + 12;
}

function toDisplayString(date: Date): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const h12 = to12h(date.getHours());
  const period = date.getHours() < 12 ? "AM" : "PM";
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${pad(h12)}:${pad(date.getMinutes())} ${period}`;
}

/* ─── sub-component: scroll drum ────────────────────────────────────────── */

function TimeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </span>
      <div className="h-[108px] w-12 overflow-y-auto rounded-md border border-border bg-background">
        <div className="flex flex-col">
          {options.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              className={cn(
                "w-full py-1 text-center text-[13px] font-mono tabular-nums transition-colors",
                value === n
                  ? "font-bold text-white"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              style={value === n ? { backgroundColor: ACCENT } : undefined}
            >
              {pad(n)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── sub-component: AM/PM toggle ───────────────────────────────────────── */

function AmPmToggle({
  value,
  onChange,
}: {
  value: "AM" | "PM";
  onChange: (p: "AM" | "PM") => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        &nbsp;
      </span>
      <div className="flex flex-col overflow-hidden rounded-md border border-border">
        {(["AM", "PM"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              "px-3 py-2.5 text-[12px] font-bold transition-colors",
              value === p
                ? "text-white"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            style={value === p ? { backgroundColor: ACCENT } : undefined}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── main component ────────────────────────────────────────────────────── */

export function DateTimePicker({
  value,
  onChange,
  disabled = false,
  placeholder = "Pick date & time",
  fromDate,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const current = React.useMemo(() => {
    if (!value) return undefined;
    const d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d;
  }, [value]);

  const [selected, setSelected] = React.useState<Date | undefined>(current);
  const [hour12, setHour12] = React.useState<number>(current ? to12h(current.getHours()) : 8);
  const [minute, setMinute] = React.useState(current?.getMinutes() ?? 0);
  const [period, setPeriod] = React.useState<"AM" | "PM">(
    current ? (current.getHours() < 12 ? "AM" : "PM") : "AM",
  );
  const [month, setMonth] = React.useState<Date>(current ?? new Date());

  React.useEffect(() => {
    if (current) {
      setSelected(current);
      setHour12(to12h(current.getHours()));
      setMinute(current.getMinutes());
      setPeriod(current.getHours() < 12 ? "AM" : "PM");
      setMonth(current);
    }
  }, [current]);

  React.useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  function commit(day: Date | undefined, h12: number, m: number, p: "AM" | "PM") {
    if (!day) { onChange(undefined); return; }
    const result = new Date(day);
    result.setHours(to24h(h12, p), m, 0, 0);
    onChange(result.toISOString());
  }

  function handleDaySelect(day: Date | undefined) {
    setSelected(day);
    commit(day, hour12, minute, period);
  }
  function handleHour(h: number) { setHour12(h); commit(selected, h, minute, period); }
  function handleMinute(m: number) { setMinute(m); commit(selected, hour12, m, period); }
  function handlePeriod(p: "AM" | "PM") { setPeriod(p); commit(selected, hour12, minute, p); }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(undefined);
    setHour12(8);
    setMinute(0);
    setPeriod("AM");
    onChange(undefined);
  }

  const hourOptions = Array.from({ length: 12 }, (_, i) => i + 1);
  const minuteOptions = Array.from({ length: 60 }, (_, i) => i);

  const previewDate = React.useMemo(() => {
    if (!selected) return undefined;
    const d = new Date(selected);
    d.setHours(to24h(hour12, period), minute, 0, 0);
    return d;
  }, [selected, hour12, minute, period]);

  return (
    <div ref={containerRef} className="relative">
      {/* ── Trigger ── */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors",
          "hover:border-stone-400 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60",
          open && "border-accent",
        )}
        style={open ? { borderColor: ACCENT } : undefined}
      >
        <span className="flex items-center gap-2">
          <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {current ? (
            <span>{toDisplayString(current)}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        {current ? (
          <X
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-red-500"
            onClick={handleClear}
            aria-label="Clear date"
          />
        ) : null}
      </button>

      {/* ── Popover ── */}
      {open ? (
        <div
          className="absolute z-50 mt-1 overflow-hidden rounded-xl border border-border bg-background shadow-xl"
          style={{ minWidth: 480 }}
        >
          {/* ── Body: calendar LEFT, time RIGHT ── */}
          <div className="flex">
            {/* Calendar */}
            <div className="flex-1 px-3 pt-3 pb-2">
              <DayPicker
                mode="single"
                selected={selected}
                onSelect={handleDaySelect}
                month={month}
                onMonthChange={setMonth}
                fromDate={fromDate}
                showOutsideDays
                classNames={{
                  root: "w-full",
                  months: "w-full",
                  month: "w-full",
                  month_caption: "flex items-center justify-between px-1 pb-1.5",
                  caption_label:
                    "text-[11px] font-bold uppercase tracking-[0.12em] text-foreground",
                  nav: "flex items-center gap-1",
                  button_previous: cn(
                    "flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground",
                    "hover:border-stone-400 hover:text-foreground transition-colors",
                  ),
                  button_next: cn(
                    "flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground",
                    "hover:border-stone-400 hover:text-foreground transition-colors",
                  ),
                  weeks: "w-full",
                  week: "grid grid-cols-7",
                  weekdays: "grid grid-cols-7 mb-0.5",
                  weekday:
                    "text-center text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground py-0.5",
                  day: "p-0",
                  day_button: cn(
                    "mx-auto flex h-7 w-7 items-center justify-center rounded-md text-[11px] transition-colors",
                    "hover:bg-muted",
                  ),
                  selected: "rounded-md text-white font-bold",
                  today: "font-bold",
                  outside: "opacity-30",
                  disabled: "opacity-30 pointer-events-none",
                }}
                components={{
                  Chevron: ({ orientation }) =>
                    orientation === "left" ? (
                      <ChevronLeft className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    ),
                }}
                modifiersStyles={{
                  selected: { backgroundColor: ACCENT, borderRadius: "6px" },
                  today: { color: ACCENT },
                }}
              />
            </div>

            {/* Vertical divider */}
            <div className="w-px bg-border" />

            {/* Time pickers */}
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-3">
              <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground self-start">
                Time
              </span>
              <div className="flex items-start gap-2">
                <TimeSelect
                  label="Hour"
                  value={hour12}
                  options={hourOptions}
                  onChange={handleHour}
                />
                <div className="mt-5 text-lg font-bold text-muted-foreground">:</div>
                <TimeSelect
                  label="Min"
                  value={minute}
                  options={minuteOptions}
                  onChange={handleMinute}
                />
                <AmPmToggle value={period} onChange={handlePeriod} />
              </div>
            </div>
          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground">
              {previewDate ? (
                <span className="font-mono font-semibold text-foreground">
                  {toDisplayString(previewDate)}
                </span>
              ) : (
                "No date selected"
              )}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white transition-colors"
              style={{ backgroundColor: ACCENT }}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
