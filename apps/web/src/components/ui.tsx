import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, Circle, Loader2, XCircle, type LucideIcon } from "lucide-react";

/**
 * Status colours, used the same way on every screen:
 * done = green (done / accepted / observed), attention = amber (inferred, deviation, rejected detection),
 * waiting = blue (waiting on the user: photo requested), error = red (error, cost limit), neutral = slate.
 * Colour is always paired with an icon and a word.
 */
export type Tone = "done" | "attention" | "waiting" | "error" | "neutral" | "busy";

export const TONE: Record<Tone, { chip: string; text: string; soft: string; border: string; bar: string; icon: LucideIcon }> = {
  done: { chip: "bg-green-100 text-green-900", text: "text-green-800", soft: "bg-green-50", border: "border-green-300", bar: "bg-green-600", icon: CheckCircle2 },
  attention: { chip: "bg-amber-100 text-amber-950", text: "text-amber-800", soft: "bg-amber-50", border: "border-amber-300", bar: "bg-amber-500", icon: AlertTriangle },
  waiting: { chip: "bg-blue-100 text-blue-900", text: "text-blue-800", soft: "bg-blue-50", border: "border-blue-300", bar: "bg-blue-600", icon: Camera },
  error: { chip: "bg-red-100 text-red-900", text: "text-red-800", soft: "bg-red-50", border: "border-red-300", bar: "bg-red-600", icon: XCircle },
  neutral: { chip: "bg-slate-100 text-slate-800", text: "text-slate-700", soft: "bg-slate-50", border: "border-slate-200", bar: "bg-slate-500", icon: Circle },
  busy: { chip: "bg-accent-soft text-accent-strong", text: "text-accent-strong", soft: "bg-accent-soft", border: "border-teal-200", bar: "bg-accent", icon: Loader2 },
};

export function Chip({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: LucideIcon }) {
  const t = TONE[tone];
  const Icon = icon ?? t.icon;
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${t.chip}`}>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${tone === "busy" ? "animate-spin" : ""}`} aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

const VISIT_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  queued: { tone: "busy", label: "Queued" },
  processing: { tone: "busy", label: "Agent running" },
  needs_input: { tone: "waiting", label: "Needs photo" },
  assessed: { tone: "attention", label: "To review" },
  reviewed: { tone: "done", label: "Reviewed" },
  reported: { tone: "done", label: "Reported" },
};

export function VisitStatusChip({ status }: { status: string }) {
  const s = VISIT_STATUS[status] ?? { tone: "neutral" as const, label: status.replace("_", " ") };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export function ProgressBar({ pct, tone = "done", className = "" }: { pct: number | undefined; tone?: Tone; className?: string }) {
  return (
    <div className={`h-2.5 overflow-hidden rounded-full bg-slate-200 ${className}`} role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${TONE[tone].bar}`} style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
    </div>
  );
}

export function ProgressRing({ pct, size = 56 }: { pct: number | null | undefined; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const value = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={6} className="stroke-slate-200" />
        {pct != null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={6} strokeLinecap="round" className="stroke-accent" strokeDasharray={`${(value / 100) * c} ${c}`} />
        )}
      </svg>
      <span className="num absolute inset-0 flex items-center justify-center text-sm font-bold">{pct == null ? "—" : `${Math.round(value)}%`}</span>
    </div>
  );
}

/** Compact sticky top bar for inner pages: back arrow, title, small subtitle, optional actions. */
export function TopBar({ back, title, subtitle, right }: { back?: string; title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 -mx-4 mb-4 border-b border-slate-200 bg-canvas/95 px-2 backdrop-blur sm:-mx-6 sm:px-4">
      <div className="flex min-h-14 items-center gap-1">
        {back && (
          <Link to={back} className="btn-ghost -ml-1 shrink-0 px-2" aria-label="Back">
            <ArrowLeft className="h-6 w-6" />
          </Link>
        )}
        <div className={`min-w-0 flex-1 py-1.5 ${back ? "" : "pl-2"}`}>
          <h1 className="truncate text-lg leading-tight font-bold">{title}</h1>
          {subtitle && <div className="flex min-w-0 items-center gap-2 truncate text-sm text-slate-600">{subtitle}</div>}
        </div>
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
    </header>
  );
}

/**
 * The screen's primary action: a sticky bar at the bottom on phones (thumb reach), inline at the end of the page on
 * wider screens. Pages leave room for it with <BottomBarSpacer /> .
 */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur md:sticky md:mx-auto md:mt-6 md:max-w-5xl md:rounded-2xl md:border md:pb-3">
      <div className="mx-auto flex max-w-5xl items-center gap-2">{children}</div>
    </div>
  );
}

export function BottomBarSpacer() {
  return <div className="h-24 md:hidden" aria-hidden />;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-8 items-center gap-2">
      <h2 className="text-base font-bold">{children}</h2>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 px-4 py-8 text-center">
      <Icon className="h-8 w-8 text-slate-400" aria-hidden />
      <p className="font-semibold">{title}</p>
      {children && <div className="text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 py-10 text-slate-600">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> Loading…
    </div>
  );
}

// ---- pure display helpers ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-28" → "28 Oct 2026" (no timezone shifts: the API sends plain dates). */
export function fmtDate(iso: string | null | undefined, withYear = true): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${withYear ? ` ${m[1]}` : ""}`;
}

/** Quantities: up to 2 decimals, no trailing zeros. */
export function fmtQty(n: number | null | undefined): string {
  if (n == null) return "—";
  return String(Math.round(n * 100) / 100);
}

/** "Photo 2": position of the photo within its visit, which is what people see; falls back to the id. */
export function photoLabel(photoIds: number[], id: number): string {
  const i = photoIds.indexOf(id);
  return i >= 0 ? `Photo ${i + 1}` : `Photo #${id}`;
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Latest completed stage implied by a staged item's percent (cumulative weights), for display. */
export function stageForPercent(stages: { name: string; weight: number }[] | null | undefined, pct: number | undefined): string | null {
  if (!stages?.length || pct == null) return null;
  let cum = 0;
  let reached: string | null = null;
  for (const s of stages) {
    cum += s.weight * 100;
    if (pct + 0.5 >= cum) reached = s.name;
  }
  return reached;
}
