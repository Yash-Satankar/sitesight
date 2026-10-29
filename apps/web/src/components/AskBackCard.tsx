import { Link } from "react-router-dom";
import { Camera, MapPinned } from "lucide-react";
import type { AskBack } from "@sitesight/shared";
import { fmtDate } from "./ui";

/** A photo the agent asked for (blue = waiting on the user). */
export function AskBackCard({
  askBack,
  zoneName,
  onSkip,
  captureVisitId = askBack.visitId,
  fromVisitDate,
  itemCode,
  showAction = true,
}: {
  askBack: AskBack;
  zoneName: string | undefined;
  onSkip?: () => void;
  /** Visit the new photo is taken in. For a request from an earlier visit this is the current visit. */
  captureVisitId?: number;
  /** Set when the request comes from an earlier visit. */
  fromVisitDate?: string;
  itemCode?: string;
  showAction?: boolean;
}) {
  return (
    <article className="rounded-2xl border-2 border-blue-300 bg-blue-50 p-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold tracking-wide text-blue-900 uppercase">
        <span className="inline-flex items-center gap-1">
          <Camera className="h-4 w-4" aria-hidden /> Photo requested
        </span>
        <span className="inline-flex items-center gap-1 font-semibold normal-case">
          <MapPinned className="h-3.5 w-3.5" aria-hidden />
          {zoneName ?? `zone ${askBack.zoneId}`}
          {itemCode ? ` · ${itemCode}` : ""}
        </span>
      </p>
      <p className="mt-2 text-base leading-snug font-semibold text-slate-900">{askBack.instruction}</p>
      <p className="mt-1 text-sm text-slate-700">
        <span className="font-semibold">Why:</span> {askBack.reason}
      </p>
      {fromVisitDate && <p className="mt-1 text-xs text-blue-900">Asked on the visit of {fmtDate(fromVisitDate)}</p>}
      {showAction && (
        <div className="mt-3 flex gap-2">
          <Link className="btn flex-1 bg-blue-700 hover:bg-blue-800" to={`/visits/${captureVisitId}/capture?zone=${askBack.zoneId}&askBack=${askBack.id}`}>
            <Camera className="h-5 w-5" aria-hidden /> Take this photo
          </Link>
          {onSkip && (
            <button className="btn-secondary" onClick={onSkip}>
              Skip
            </button>
          )}
        </div>
      )}
    </article>
  );
}
