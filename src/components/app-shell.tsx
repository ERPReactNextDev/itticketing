"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  FileText,
  Users,
  UserCog,
  SlidersHorizontal,
  ShieldCheck,
  Mail,
  ScrollText,
  LogOut,
  Search,
  Filter,
  Download,
  Plus,
  Bell,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Info,
  Command,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import type { PermissionKey, SessionUser } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { ACCENT } from "@/components/ui/primitives";

/* ── Design language ─────────────────────────────────────────────────────────
   Orange accent (#f97316), monospace uppercase labels, left sidebar + top bar.
   The accent also lives in globals.css as --accent-orange so a palette change
   only has to touch one place. */

export { ACCENT };

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Visible only when the user holds any one of these permissions. */
  permissions?: PermissionKey[];
  badge?: "tickets";
};

type NavSection = {
  title: string;
  items: NavItem[];
};

/**
 * Sidebar structure.
 *
 * Groups mirror the product's mental model: what you work on (Workspace), who
 * you work for (Directory), and how the system is configured (Super Admin).
 */
const NAV_SECTIONS: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permissions: ["viewDashboard"] },
      { label: "Tickets", href: "/tickets", icon: Inbox, badge: "tickets" },
      { label: "Ticket Detail", href: "/tickets/recent", icon: FileText },
    ],
  },
  {
    title: "Directory",
    items: [
      { label: "Requestors / Users", href: "/directory/requestors", icon: Users, permissions: ["manageRequestors", "createTicket"] },
      { label: "Staff & Agents", href: "/directory/staff", icon: UserCog, permissions: ["manageUsers"] },
    ],
  },
  {
    title: "Super Admin",
    items: [
      { label: "Configuration", href: "/configuration/dropdowns", icon: SlidersHorizontal, permissions: ["manageDropdowns", "manageSettings"] },
      { label: "Roles & Access", href: "/configuration/roles", icon: ShieldCheck, permissions: ["manageRoles"] },
      { label: "Email / Resend", href: "/configuration/email", icon: Mail, permissions: ["manageSettings"] },
      { label: "Audit Logs", href: "/audit-logs", icon: ScrollText, permissions: ["viewAuditLogs"] },
    ],
  },
];

function canSee(user: SessionUser, item: NavItem): boolean {
  if (!item.permissions?.length) return true;
  return item.permissions.some((permission) => user.permissions[permission]);
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/tickets") return pathname === "/tickets" || pathname === "/tickets/new";
  if (href === "/configuration/dropdowns") {
    // Active for all /configuration/* EXCEPT /configuration/roles
    return pathname.startsWith("/configuration") && !pathname.startsWith("/configuration/roles");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type AppShellProps = {
  user: SessionUser;
  children: React.ReactNode;
  /** Count shown on the Tickets nav item. */
  openTicketCount?: number;
  /** Most recent auto-created inbound concerns, for the Gmail card. */
  gmailCard?: { count: number; window: string };
  /** Primary page action, rendered in the top bar. */
  actions?: React.ReactNode;
  /** Search placeholder + handler, wired to the top bar search box. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  onFiltersClick?: () => void;
  activeFilterCount?: number;
};

export function AppShell(props: AppShellProps) {
  const {
    user,
    children,
    openTicketCount,
    gmailCard,
    actions,
    search,
    onFiltersClick,
    activeFilterCount = 0,
  } = props;

  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // Close mobile sidebar on navigation.
  React.useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Close on Escape key.
  React.useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => canSee(user, item)),
  })).filter((section) => section.items.length > 0);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await api.post("/api/auth/logout");
    } catch {
      // Even if the request fails, clear the client state and leave.
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${ACCENT}1f`, color: ACCENT }}
          >
            <Command className="h-4 w-4" strokeWidth={2.5} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold uppercase tracking-wide text-foreground">
              Help Desk
            </p>
            <p className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              IT Ticketing v2.0
            </p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {sections.map((section) => (
            <div key={section.title} className="mb-5">
              <p className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[11px] uppercase tracking-[0.12em] transition-colors",
                          active
                            ? "bg-accent/10 text-accent"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                        style={active ? { color: ACCENT } : undefined}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge === "tickets" && typeof openTicketCount === "number" && openTicketCount > 0 ? (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                            style={{ backgroundColor: `${ACCENT}26`, color: ACCENT }}
                          >
                            {openTicketCount}
                          </span>
                        ) : null}
                        {active ? (
                          <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Gmail intake status */}
        {gmailCard && gmailCard.count > 0 ? (
          <div className="mx-3 mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/40">
            <div className="mb-1 flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-emerald-700 dark:text-emerald-400">
                Gmail Inbox
              </span>
              <span className="ml-auto rounded-full bg-emerald-600 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white">
                Live
              </span>
            </div>
            <p className="text-[10px] leading-relaxed text-emerald-800/80 dark:text-emerald-300/80">
              {gmailCard.count} new {gmailCard.count === 1 ? "concern" : "concerns"} auto-created
              from Gmail in the {gmailCard.window}.
            </p>
          </div>
        ) : null}

        {/* Signed-in user */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
              style={{ backgroundColor: ACCENT }}
            >
              {initials || "?"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold text-foreground">{user.name}</p>
              <p className="truncate text-[10px]" style={{ color: ACCENT }}>
                {user.roleName}
              </p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              title="Sign out"
              aria-label="Sign out"
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Mobile sidebar overlay ───────────────────────────────────── */}
      {sidebarOpen ? (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
          {/* Drawer */}
          <aside className="fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-border bg-card lg:hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${ACCENT}1f`, color: ACCENT }}
                >
                  <Command className="h-4 w-4" strokeWidth={2.5} />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold uppercase tracking-wide text-foreground">
                    Help Desk
                  </p>
                  <p className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    IT Ticketing v2.0
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-4">
              {sections.map((section) => (
                <div key={section.title} className="mb-5">
                  <p className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    {section.title}
                  </p>
                  <ul className="space-y-0.5">
                    {section.items.map((item) => {
                      const Icon = item.icon;
                      const active = isActive(pathname, item.href);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            className={cn(
                              "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[11px] uppercase tracking-[0.12em] transition-colors",
                              active
                                ? "bg-accent/10 text-accent"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                            style={active ? { color: ACCENT } : undefined}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="flex-1 truncate">{item.label}</span>
                            {item.badge === "tickets" && typeof openTicketCount === "number" && openTicketCount > 0 ? (
                              <span
                                className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                                style={{ backgroundColor: `${ACCENT}26`, color: ACCENT }}
                              >
                                {openTicketCount}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
            <div className="border-t border-border p-3">
              <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ backgroundColor: ACCENT }}
                >
                  {initials || "?"}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-foreground">{user.name}</p>
                  <p className="truncate text-[10px]" style={{ color: ACCENT }}>
                    {user.roleName}
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </>
      ) : null}

      {/* ── Main column ──────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:px-6">
          {/* Mobile hamburger — hidden on desktop */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-md border border-border p-2 text-muted-foreground transition-colors hover:bg-muted lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>

          {search ? (
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                placeholder={search.placeholder ?? "Search tickets, requestors, ticket number"}
                className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[11px] tracking-wide outline-none transition-colors placeholder:text-muted-foreground focus:border-accent"
              />
            </div>
          ) : (
            <div className="flex-1" />
          )}

          {onFiltersClick ? (
            <button
              type="button"
              onClick={onFiltersClick}
              className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[11px] uppercase tracking-[0.12em] text-foreground transition-colors hover:bg-muted"
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
              {activeFilterCount > 0 ? (
                <span
                  className="rounded-full px-1.5 text-[9px] font-bold text-white"
                  style={{ backgroundColor: ACCENT }}
                >
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          ) : null}

          {actions}

          {/* Notification bell: surfaces open tickets assigned to this user. */}
          <Link
            href="/tickets"
            className="relative rounded-md border border-border p-2 text-muted-foreground transition-colors hover:bg-muted"
            title={openTicketCount ? `${openTicketCount} open ticket${openTicketCount === 1 ? "" : "s"}` : "Tickets"}
            aria-label={openTicketCount ? `${openTicketCount} open tickets` : "View tickets"}
          >
            <Bell className="h-4 w-4" />
            {typeof openTicketCount === "number" && openTicketCount > 0 ? (
              <span
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-background"
                style={{ backgroundColor: "#ef4444" }}
              />
            ) : null}
          </Link>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 py-5 lg:px-6">{children}</main>
      </div>
    </div>
  );
}

/* ── Shared presentational pieces ─────────────────────────────────────────── */

export function PageHeading({
  title,
  description,
  badge,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-bold tracking-tight text-foreground">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent,
  icon: Icon,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  accent?: string;
  icon?: LucideIcon;
  loading?: boolean;
}) {
  const colour = accent ?? ACCENT;
  return (
    <div
      className="rounded-lg border border-border bg-card p-4"
      style={{ borderTopColor: colour, borderTopWidth: 2 }}
    >
      <div className="mb-2 flex items-center gap-1.5">
        {Icon ? <Icon className="h-3.5 w-3.5" style={{ color: colour }} /> : null}
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          {label}
        </p>
      </div>
      {loading ? (
        <div className="h-9 w-20 animate-pulse rounded bg-muted" />
      ) : (
        <p className="text-3xl font-bold tabular-nums text-foreground">{value}</p>
      )}
      {hint ? <p className="mt-1.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TerminalBadge({
  label,
  color,
  inactive,
}: {
  label: string;
  color?: string;
  inactive?: boolean;
}) {
  const tone = color ?? ACCENT;
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
      style={{
        color: inactive ? "#94a3b8" : tone,
        borderColor: inactive ? "#cbd5e1" : `${tone}55`,
        backgroundColor: inactive ? "#f1f5f9" : `${tone}14`,
        textDecoration: inactive ? "line-through" : undefined,
      }}
      title={inactive ? `${label} (inactive)` : label}
    >
      {label}
    </span>
  );
}

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.15em] text-foreground">
            {title}
          </h2>
          {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function PrimaryButton({
  children,
  icon: Icon,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
        rest.className,
      )}
      style={{ backgroundColor: ACCENT }}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  icon: Icon,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
        rest.className,
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}

export function AlertBanner({
  title,
  children,
  tone = "warning",
}: {
  title: string;
  children?: React.ReactNode;
  tone?: "warning" | "danger" | "info" | "success";
}) {
  const tones = {
    warning: { bg: "#ef444414", border: "#ef444455", colour: "#dc2626" },
    danger: { bg: "#dc262614", border: "#dc262655", colour: "#b91c1c" },
    info: { bg: `${ACCENT}14`, border: `${ACCENT}55`, colour: ACCENT },
    success: { bg: "#22c55e14", border: "#22c55e55", colour: "#16a34a" },
  }[tone];

  const TONE_ICONS = {
    warning: AlertTriangle,
    danger: AlertTriangle,
    info: Info,
    success: CheckCircle2,
  };
  const ToneIcon = TONE_ICONS[tone];

  return (
    <div
      className="flex items-start gap-3 rounded-lg border p-3.5"
      style={{ backgroundColor: tones.bg, borderColor: tones.border }}
      role="alert"
    >
      <ToneIcon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: tones.colour }} />
      <div className="min-w-0 flex-1">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.15em]"
          style={{ color: tones.colour }}
        >
          {title}
        </p>
        {children ? (
          <div className="mt-1 text-[11px] leading-relaxed text-foreground/80">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return (
    <AlertBanner tone="danger" title="Something went wrong">
      {message}
    </AlertBanner>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <Icon className="mb-3 h-6 w-6 text-muted-foreground" />
      <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-foreground">
        {title}
      </p>
      {description ? (
        <p className="mt-1 max-w-sm text-[11px] text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}