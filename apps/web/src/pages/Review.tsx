import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, FileText, Pencil, Ruler, TriangleAlert, Undo2 } from "lucide-react";
import type { Assessment, BoqItem, Photo } from "@sitesight/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { PhotoWithMasks } from "../components/PhotoWithMasks";
import { AssessmentChip } from "../components/AssessmentChip";
import { ErrorNote } from "../components/Layout";
import { BottomBar, BottomBarSpacer, Loading, ProgressBar, TopBar, capitalize, fmtDate, fmtQty, photoLabel } from "../components/ui";

export function ReviewPage() {
  const visitId = Number(useParams().visitId);
  const { data, error, reload } = useAsync(async () => {
    const visit = await api.getVisit(visitId);
    const project = await api.getProject(visit.projectId);
    return { visit, project };
  }, [visitId]);

  if (error) return <div className="pt-4"><ErrorNote error={error} /></div>;
  if (!data) return <Loading />;
  const { visit, project } = data;
  const pending = visit.assessments.filter((a) => a.status === "proposed").length;
  const awaiting = new Set([...visit.askBacks.filter((a) => a.status === "open"), ...visit.earlierOpenAskBacks].map((a) => a.boqItemId));
  const photoIds = visit.photos.map((p) => p.id);

  return (
    <div className="mx-auto max-w-3xl">
      <TopBar
        back={`/visits/${visitId}`}
        title="Review"
        subtitle={
          <span className="num truncate">
            {project.name} · {fmtDate(visit.visitDate)}
          </span>
        }
      />
      <p className="num mb-4 text-sm text-slate-700">
        {pending ? (
          <>
            <strong>{pending}</strong> of {visit.assessments.length} still to review
          </>
        ) : (
          <>All {visit.assessments.length} assessments reviewed</>
        )}
      </p>
      <div className="space-y-5">
        {visit.assessments.map((a) => (
          <ReviewCard
            key={a.id}
            assessment={a}
            item={project.boqItems.find((b) => b.id === a.boqItemId)}
            photos={visit.photos}
            photoIds={photoIds}
            awaitingPhoto={awaiting.has(a.boqItemId)}
            onChange={reload}
          />
        ))}
      </div>
      <BottomBarSpacer />
      <BottomBar>
        <Link className="btn flex-1" to={`/visits/${visitId}/report`}>
          <FileText className="h-5 w-5" aria-hidden /> {pending ? "Continue to report" : "Create report"}
        </Link>
      </BottomBar>
    </div>
  );
}

function ReviewCard({
  assessment: a,
  item,
  photos,
  photoIds,
  awaitingPhoto,
  onChange,
}: {
  assessment: Assessment;
  item: BoqItem | undefined;
  photos: Photo[];
  photoIds: number[];
  awaitingPhoto: boolean;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(a.percentComplete);
  const [qty, setQty] = useState<string>(a.qtyDone?.toString() ?? "");
  const [note, setNote] = useState(a.engineerNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [moreText, setMoreText] = useState(false);

  async function submit(action: "accept" | "edit") {
    try {
      await api.patchAssessment(a.id, {
        action,
        engineerNote: note || undefined,
        ...(action === "edit" ? { percentComplete: pct, qtyDone: qty === "" ? null : Number(qty) } : {}),
      });
      setEditing(false);
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Back to "proposed"; the API refuses (with a reason) if a report generated since already includes it. */
  async function undo() {
    setError(null);
    try {
      await api.patchAssessment(a.id, { status: "proposed" });
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const confirmed = a.status === "accepted" || a.status === "edited";
  const [first, ...rest] = a.evidence.slice(0, 4);
  const panelsFor = (photoId: number) => a.panels.filter((p) => p.photoId === photoId).map((p) => p.id);

  return (
    <article className={`card space-y-3 ${confirmed ? "border-green-300" : ""}`}>
      <header className="space-y-2">
        <h2 className="text-base leading-snug font-bold">
          <span className="mr-1.5 font-mono text-sm font-semibold text-slate-600">{item?.code}</span>
          {item?.description}
        </h2>
        <AssessmentChip assessment={a} awaitingPhoto={awaitingPhoto} />
      </header>

      <div className="flex items-end gap-4">
        <p className="num text-5xl leading-none font-bold tracking-tight">{Math.round(a.percentComplete)}%</p>
        <div className="min-w-0 flex-1 pb-1 text-sm">
          {a.stageReached && <p className="font-semibold">{capitalize(a.stageReached)} stage</p>}
          {a.qtyDone != null && (
            <p className="num text-slate-700">
              {fmtQty(a.qtyDone)} / {fmtQty(item?.plannedQty)} {item?.unit}
            </p>
          )}
        </div>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs font-semibold text-slate-600">
          <span>Confidence</span>
          <span className="num">{Math.round(a.confidence * 100)}%</span>
        </div>
        <ProgressBar pct={a.confidence * 100} tone={a.confidence < 0.6 ? "attention" : "neutral"} />
      </div>

      {a.deviation && (
        <div className="flex items-start gap-2 rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden />
          <p>
            <span className="font-bold">Deviation · </span>
            {a.deviation}
          </p>
        </div>
      )}

      {first && (
        <PhotoWithMasks photo={photos.find((p) => p.id === first.photoId)} segmentIds={first.segmentIds} panelIds={panelsFor(first.photoId)} label={photoLabel(photoIds, first.photoId)} />
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {rest.map((ev) => (
            <PhotoWithMasks key={ev.photoId} photo={photos.find((p) => p.id === ev.photoId)} segmentIds={ev.segmentIds} panelIds={panelsFor(ev.photoId)} label={photoLabel(photoIds, ev.photoId)} />
          ))}
        </div>
      )}
      {a.panels.length > 0 && (
        <p className="num flex items-center gap-1.5 text-sm text-slate-700">
          <Ruler className="h-4 w-4 shrink-0" aria-hidden />
          Measured bay{a.panels.length > 1 ? "s" : ""}: {a.panels.map((p) => `${Math.round(p.fraction * 100)}% built`).join(", ")}
        </p>
      )}

      {a.rationale && (
        <div>
          <p className={`text-[15px] leading-relaxed text-slate-800 ${moreText ? "" : "line-clamp-3"}`}>{a.rationale}</p>
          {a.rationale.length > 160 && (
            <button className="min-h-10 text-sm font-semibold text-accent" onClick={() => setMoreText((v) => !v)}>
              {moreText ? "less" : "more"}
            </button>
          )}
        </div>
      )}

      {editing && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-semibold">
            % complete
            <input className="input num mt-1" type="number" inputMode="decimal" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
          </label>
          <label className="block text-sm font-semibold">
            Qty done ({item?.unit})
            <input className="input num mt-1" type="number" inputMode="decimal" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
        </div>
      )}
      {(!confirmed || editing) && (
        <textarea className="input min-h-12 py-2.5" placeholder="Engineer note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      )}
      {confirmed && !editing && a.engineerNote && <p className="text-sm text-slate-700"><span className="font-semibold">Note:</span> {a.engineerNote}</p>}
      <ErrorNote error={error} />

      {editing ? (
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={() => submit("edit")}>
            Save changes
          </button>
          <button className="btn-secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : confirmed ? (
        <div className="flex min-h-12 items-center gap-2 rounded-xl bg-green-50 px-3">
          <span className="font-semibold text-green-900">{a.status === "edited" ? "Edited ✓" : "Accepted ✓"}</span>
          <span className="text-green-900" aria-hidden>·</span>
          <button className="btn-ghost min-h-11 px-2 text-sm font-semibold text-slate-800 underline underline-offset-2" onClick={undo}>
            <Undo2 className="h-4 w-4" aria-hidden /> Undo
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={() => submit("accept")}>
            <Check className="h-5 w-5" aria-hidden /> Accept
          </button>
          <button className="btn-secondary px-5" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" aria-hidden /> Edit
          </button>
        </div>
      )}
    </article>
  );
}
