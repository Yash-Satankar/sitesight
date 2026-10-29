import { useEffect, useMemo, useRef, useState } from "react";
import { buildTraceCards, type AgentStep, type CardTone, type TraceCard } from "@sitesight/shared";
import { overlayUrl } from "./PhotoWithMasks";

const TONE: Record<CardTone, { card: string; label: string }> = {
  neutral: { card: "border-gray-200 bg-white", label: "text-gray-500" },
  agent: { card: "border-violet-200 bg-violet-50", label: "text-violet-700" },
  rejection: { card: "border-amber-300 bg-amber-50", label: "text-amber-800" },
  assessment: { card: "border-green-300 bg-green-50", label: "text-green-800" },
  askback: { card: "border-sky-300 bg-sky-50", label: "text-sky-800" },
  notice: { card: "border-gray-200 bg-gray-50", label: "text-gray-500" },
  error: { card: "border-red-300 bg-red-50", label: "text-red-800" },
};
const TONE_LABEL: Record<CardTone, string> = {
  neutral: "step",
  agent: "agent",
  rejection: "rejected",
  assessment: "assessment",
  askback: "photo request",
  notice: "note",
  error: "error",
};

/**
 * Live agent trace as readable cards (the demo's centrepiece). Sticky header with step count and running
 * cost; follows new cards unless the user has scrolled up, then offers "Jump to latest".
 */
export function AgentTrace({
  steps,
  costUsd,
  status,
  itemCode,
}: {
  steps: AgentStep[];
  costUsd: number | null;
  status?: string;
  itemCode?: (boqItemId: number) => string | undefined;
}) {
  const cards = useMemo(() => buildTraceCards(steps, { itemCode }), [steps, itemCode]);
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (following) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [cards.length, following]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  return (
    <div className="relative flex max-h-[75vh] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-200 bg-white/95 px-4 py-2 text-sm backdrop-blur">
        <h2 className="font-semibold">Agent trace</h2>
        <span className="text-gray-600">{steps.length} steps</span>
        <span className="font-mono text-gray-800">${(costUsd ?? 0).toFixed(4)}</span>
        {status && <span className="ml-auto text-xs uppercase text-gray-500">{status.replace("_", " ")}</span>}
      </div>
      <div ref={scroller} onScroll={onScroll} className="flex-1 space-y-2 overflow-y-auto p-3">
        {!cards.length && <p className="text-sm text-gray-500">Waiting for the agent…</p>}
        {cards.map((c) => (
          <Card key={c.id} card={c} />
        ))}
      </div>
      {!following && cards.length > 0 && (
        <button
          className="btn absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg"
          onClick={() => {
            setFollowing(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

function Card({ card }: { card: TraceCard }) {
  const tone = TONE[card.tone];
  const thumb = card.overlay ? overlayUrl(card.overlay.photoId, card.overlay.segmentIds, card.overlay.panelIds, 360) : null;
  const full = card.overlay ? overlayUrl(card.overlay.photoId, card.overlay.segmentIds, card.overlay.panelIds, 1280) : null;
  return (
    <article className={`rounded-lg border px-3 py-2 text-sm ${tone.card}`}>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-[11px] font-medium uppercase tracking-wide ${tone.label}`}>{TONE_LABEL[card.tone]}</p>
          <p className="font-medium text-gray-900">{card.title}</p>
          {card.subtitle && <p className="mt-0.5 text-xs text-gray-600">{card.subtitle}</p>}
        </div>
        {thumb && full && (
          <a href={full} target="_blank" rel="noreferrer" className="shrink-0">
            <img src={thumb} alt="" loading="lazy" decoding="async" className="h-16 w-24 rounded object-cover sm:h-20 sm:w-28" />
          </a>
        )}
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-gray-400">details</summary>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] text-gray-700">
          {JSON.stringify(card.details, null, 2)}
        </pre>
      </details>
    </article>
  );
}
