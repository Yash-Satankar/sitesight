import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Assessment, BoqItem, Photo } from "@sitesight/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { PhotoWithMasks } from "../components/PhotoWithMasks";
import { ErrorNote, InferredBadge, StatusBadge } from "../components/Layout";

export function ReviewPage() {
  const visitId = Number(useParams().visitId);
  const { data, error, reload } = useAsync(async () => {
    const visit = await api.getVisit(visitId);
    const project = await api.getProject(visit.projectId);
    return { visit, project };
  }, [visitId]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const { visit, project } = data;
  const pending = visit.assessments.filter((a) => a.status === "proposed").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Link to={`/visits/${visitId}`} className="text-sm text-gray-500 hover:underline">
            ← Visit {visit.visitDate}
          </Link>
          <h1 className="text-xl font-semibold">Review assessments</h1>
          <p className="text-sm text-gray-500">{pending} awaiting review</p>
        </div>
        <Link className="btn ml-auto" to={`/visits/${visitId}/report`}>
          Report
        </Link>
      </div>
      {visit.assessments.map((a) => (
        <ReviewCard
          key={a.id}
          assessment={a}
          item={project.boqItems.find((b) => b.id === a.boqItemId)}
          photos={visit.photos}
          onChange={reload}
        />
      ))}
    </div>
  );
}

function ReviewCard({
  assessment: a,
  item,
  photos,
  onChange,
}: {
  assessment: Assessment;
  item: BoqItem | undefined;
  photos: Photo[];
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(a.percentComplete);
  const [qty, setQty] = useState<string>(a.qtyDone?.toString() ?? "");
  const [note, setNote] = useState(a.engineerNote ?? "");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <article className="card grid gap-4 md:grid-cols-[1fr_1.2fr]">
      <div className={`grid gap-2 ${a.evidence.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
        {a.evidence.slice(0, 4).map((ev) => (
          <PhotoWithMasks
            key={ev.photoId}
            photo={photos.find((p) => p.id === ev.photoId)}
            segmentIds={ev.segmentIds}
            panelIds={a.panels.filter((p) => p.photoId === ev.photoId).map((p) => p.id)}
          />
        ))}
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{item?.code}</span>
          <h3 className="flex-1 font-medium">{item?.description}</h3>
          <StatusBadge status={a.status} />
          <InferredBadge basis={a.basis} />
        </div>
        <p>
          <strong className="text-2xl">{Math.round(a.percentComplete)}%</strong>
          {a.qtyDone != null && (
            <span className="ml-2 text-gray-600">
              {a.qtyDone} / {item?.plannedQty} {item?.unit}
            </span>
          )}
          <span className="ml-2 text-gray-500">confidence {(a.confidence * 100).toFixed(0)}%</span>
        </p>
        <p className="text-gray-700">{a.rationale}</p>
        {a.panels.length > 0 && (
          <p className="text-xs text-gray-600">
            Measured panel{a.panels.length > 1 ? "s" : ""}: {a.panels.map((p) => `${Math.round(p.fraction * 100)}% filled`).join(", ")}
          </p>
        )}
        {a.deviation && <p className="rounded bg-red-50 px-2 py-1 text-red-700">Deviation: {a.deviation}</p>}

        {editing ? (
          <div className="space-y-2">
            <label className="block">
              % complete
              <input className="input" type="number" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
            </label>
            <label className="block">
              Qty done ({item?.unit})
              <input className="input" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
          </div>
        ) : null}
        <textarea className="input" placeholder="Engineer note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        <ErrorNote error={error} />
        <div className="flex gap-2">
          {editing ? (
            <>
              <button className="btn" onClick={() => submit("edit")}>
                Save edit
              </button>
              <button className="btn-secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => submit("accept")}>
                Accept
              </button>
              <button className="btn-secondary" onClick={() => setEditing(true)}>
                Edit
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
