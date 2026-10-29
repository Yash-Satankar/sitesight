import { Link } from "react-router-dom";
import type { AskBack } from "@sitesight/shared";

export function AskBackCard({
  askBack,
  zoneName,
  onSkip,
  captureVisitId = askBack.visitId,
  fromVisitDate,
}: {
  askBack: AskBack;
  zoneName: string | undefined;
  onSkip: () => void;
  /** Visit the new photo is taken in. For a request from an earlier visit this is the current visit. */
  captureVisitId?: number;
  /** Set when the request comes from an earlier visit. */
  fromVisitDate?: string;
}) {
  return (
    <div className="card border-amber-300 bg-amber-50">
      <p className="text-xs font-medium uppercase text-amber-800">
        Photo requested · {zoneName ?? `zone ${askBack.zoneId}`}
        {fromVisitDate ? ` · from the visit of ${fromVisitDate}` : ""}
      </p>
      <p className="mt-1 font-medium">{askBack.instruction}</p>
      <p className="mt-1 text-sm text-gray-600">Why: {askBack.reason}</p>
      <div className="mt-3 flex gap-2">
        <Link className="btn" to={`/visits/${captureVisitId}/capture?zone=${askBack.zoneId}&askBack=${askBack.id}`}>
          📷 Take this photo
        </Link>
        <button className="btn-secondary" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}
