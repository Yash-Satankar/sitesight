import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStep } from "@sitesight/shared";
import {
  ArrowDown,
  Camera,
  CheckCircle2,
  ClipboardList,
  Flag,
  History,
  Images,
  Info,
  Loader2,
  ScanEye,
  ScanSearch,
  ShieldCheck,
  Ruler,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { overlayUrl } from "./PhotoWithMasks";
import { Chip, TONE } from "./ui";
import { buildTimeline, type StepIcon, type TimelineItem } from "./trace/timeline";

const ICON: Record<StepIcon, LucideIcon> = {
  boq: ClipboardList,
  photos: Images,
  view: ScanEye,
  search: ScanSearch,
  verify: ShieldCheck,
  measure: Ruler,
  assess: CheckCircle2,
  request: Camera,
  history: History,
  finish: Flag,
  error: XCircle,
  note: Info,
};

/**
 * Live agent trace as a vertical timeline of plain-language cards (the demo's centrepiece). Sticky mini-header with a
 * running indicator, step count and cost; follows new steps unless the user has scrolled up, then offers "Jump to latest".
 */
export function AgentTrace({
  steps,
  costUsd,
  status,
  itemCode,
  photoName,
}: {
  steps: AgentStep[];
  costUsd: number | null;
  status?: string;
  itemCode?: (boqItemId: number) => string | undefined;
  photoName?: (photoId: number) => string;
}) {
  const items = useMemo(() => buildTimeline(steps, { itemCode, photoName }), [steps, itemCode, photoName]);
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const running = status === "queued" || status === "processing";

  useEffect(() => {
    if (following) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [items.length, following]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  return (
    <section className="relative flex max-h-[78vh] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <div className="z-10 flex min-h-12 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <h2 className="text-base font-bold">Agent trace</h2>
        {running ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent-strong">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
            Working
          </span>
        ) : null}
        <span className="num ml-auto text-sm text-slate-600">
          {steps.length} step{steps.length === 1 ? "" : "s"} · <span className="font-semibold text-slate-900">${(costUsd ?? 0).toFixed(2)}</span>
        </span>
      </div>

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-3">
        {!items.length && (
          <p className="flex items-center gap-2 px-1 py-6 text-sm text-slate-600">
            {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Info className="h-4 w-4" aria-hidden />}
            {running ? "Waiting for the agent to start…" : "The agent hasn't run on this visit yet."}
          </p>
        )}
        <ol className="relative">
          {items.map((item, i) => (
            <TimelineRow key={item.id} item={item} last={i === items.length - 1} />
          ))}
        </ol>
      </div>

      {!following && items.length > 0 && (
        <button
          className="btn absolute bottom-3 left-1/2 min-h-11 -translate-x-1/2 px-4 text-sm shadow-lg"
          onClick={() => {
            setFollowing(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown className="h-4 w-4" aria-hidden /> Jump to latest
        </button>
      )}
    </section>
  );
}

function TimelineRow({ item, last }: { item: TimelineItem; last: boolean }) {
  const t = TONE[item.tone];
  const Icon = item.pending ? Loader2 : ICON[item.icon];
  const quiet = item.type === "thinking" || item.type === "note";

  return (
    <li className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 pb-3">
      {!last && <span className="absolute top-8 bottom-0 left-4 w-px -translate-x-1/2 bg-slate-200" aria-hidden />}
      <span
        className={`relative z-[1] mt-0.5 flex h-8 w-8 items-center justify-center rounded-full ${
          quiet ? "bg-white text-slate-400" : item.pending ? "bg-accent-soft text-accent" : `${t.chip}`
        }`}
      >
        <Icon className={`h-4 w-4 ${item.pending ? "animate-spin" : ""}`} aria-hidden />
      </span>

      {quiet ? (
        <div className="min-w-0 pt-1.5">
          <p className={`text-sm leading-snug text-slate-600 ${item.type === "thinking" ? "italic" : ""}`}>{item.title}</p>
          {item.body && <p className="mt-0.5 text-xs text-slate-500">{item.body}</p>}
        </div>
      ) : (
        <StepCard item={item} />
      )}
    </li>
  );
}

function StepCard({ item }: { item: TimelineItem }) {
  const t = TONE[item.tone];
  const highlighted = item.tone !== "neutral" && !item.pending;
  const thumb = item.overlay ? overlayUrl(item.overlay.photoId, item.overlay.segmentIds, item.overlay.panelIds, 320) : null;
  const full = item.overlay ? overlayUrl(item.overlay.photoId, item.overlay.segmentIds, item.overlay.panelIds, 1400) : null;
  const [more, setMore] = useState(false);

  return (
    <article className={`min-w-0 rounded-xl border px-3 py-2.5 ${highlighted ? `${t.border} ${t.soft}` : "border-slate-200 bg-white"}`}>
      {item.chip && (
        <div className="mb-1">
          <Chip tone={item.chip.tone}>{item.chip.label}</Chip>
        </div>
      )}
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] leading-snug font-semibold break-words ${item.pending ? "text-slate-600" : "text-slate-900"}`}>{item.title}</p>
          {item.result && <p className="num mt-0.5 text-sm text-slate-700">{item.result}</p>}
        </div>
        {thumb && full && (
          <a href={full} target="_blank" rel="noreferrer" className="shrink-0" aria-label="Open the photo with its masks">
            <img src={thumb} alt="" loading="lazy" decoding="async" className="h-16 w-20 rounded-lg bg-slate-200 object-cover sm:h-20 sm:w-28" />
          </a>
        )}
      </div>

      {item.rejections && item.rejections.length > 0 && (
        <ul className="mt-2 space-y-1">
          {item.rejections.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-sm text-amber-950">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
              <span className="min-w-0">
                <span className="num font-semibold">{r.segmentId != null ? `#${r.segmentId}` : "Rejected"}</span> {r.reason}
              </span>
            </li>
          ))}
        </ul>
      )}

      {item.body && (
        <p className={`mt-1 text-sm leading-snug break-words text-slate-700 ${more ? "" : "line-clamp-2"}`} onClick={() => setMore(true)}>
          {item.body}
        </p>
      )}
      {item.meta && <p className="num mt-1 text-xs text-slate-600">{item.meta}</p>}

      <details className="group mt-1">
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center text-xs font-medium text-slate-500 select-none hover:text-slate-700">
          <span className="group-open:hidden">details</span>
          <span className="hidden group-open:inline">hide details</span>
        </summary>
        <div className="mt-1 space-y-1 rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-700">
          {item.details.steps.map((s) => (
            <p key={s}>{s}</p>
          ))}
          <pre className="max-h-56 overflow-auto break-all whitespace-pre-wrap">{JSON.stringify({ args: item.details.args, result: item.details.result }, null, 2)}</pre>
        </div>
      </details>
    </article>
  );
}
